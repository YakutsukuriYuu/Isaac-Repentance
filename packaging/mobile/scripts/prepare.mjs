import {build} from 'esbuild';
import {readFile, writeFile, access, copyFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const platform = process.argv[2];
if (!['android', 'ios', 'web'].includes(platform)) throw new Error('Usage: npm run prepare:native -- android|ios|web');
const packageVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
const buildNumber = Number(process.env.BUILD_NUMBER || process.env.GITHUB_RUN_NUMBER || 1);
if (!/^\d+\.\d+\.\d+$/.test(packageVersion) || !Number.isInteger(buildNumber) || buildNumber < 1 || buildNumber > 2100000000) throw new Error('Invalid application version or build number');
const run = (...args) => {
  const result = spawnSync(process.execPath, ['node_modules/@capacitor/cli/bin/capacitor', ...args], {stdio: 'inherit', env: {...process.env, CI: '1'}});
  if (result.status !== 0) throw new Error(`Capacitor ${args.join(' ')} failed`);
};
const exists = async file => { try { await access(file); return true; } catch { return false; } };
for (const name of ['index.html', 'app.mjs', 'asset-manifest.json', 'j835_game.mjs', 'j835_game.wasm']) {
  if (!await exists(`www/${name}`)) throw new Error(`Missing staged game file: www/${name}. Run the release staging command first.`);
}
await build({entryPoints: ['src/bootstrap.mjs'], outfile: 'www/native-bootstrap.mjs', bundle: true, format: 'esm', target: ['chrome137', 'safari27'], external: ['./app.mjs'], legalComments: 'eof', sourcemap: false});
let html = await readFile('www/index.html', 'utf8');
if (!html.includes('src="./app.mjs"') && !html.includes('src="./native-bootstrap.mjs"')) throw new Error('Cannot locate the launcher entry script');
html = html.replace('src="./app.mjs"', 'src="./native-bootstrap.mjs"');
await writeFile('www/index.html', html);
if (platform === 'web') process.exit(0);
if (!await exists(platform)) run('add', platform);
run('sync', platform);
if (platform === 'android') {
  const manifest = 'android/app/src/main/AndroidManifest.xml';
  let xml = await readFile(manifest, 'utf8');
  if (!xml.includes('android:largeHeap=')) xml = xml.replace('<application\n', '<application\n        android:largeHeap="true"\n');
  if (!xml.includes('android:appCategory=')) xml = xml.replace('<application\n', '<application\n        android:appCategory="game"\n');
  if (!xml.includes('android:screenOrientation=')) xml = xml.replace('android:name=".MainActivity"', 'android:name=".MainActivity"\n            android:screenOrientation="sensorLandscape"');
  // Existing HTML file pickers use the platform document picker. Private app
  // data stays in Documents; shared exports use the plugin's cache provider.
  await writeFile(manifest, xml);
  const config = JSON.parse(await readFile('capacitor.config.json', 'utf8'));
  const activity = `android/app/src/main/java/${config.appId.replaceAll('.', '/')}/MainActivity.java`;
  await writeFile(activity, `package ${config.appId};

import android.content.res.Configuration;
import android.hardware.display.DisplayManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Display;
import android.view.WindowManager;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity implements DisplayManager.DisplayListener {
    private static final float GAME_FRAME_RATE = 60f;
    private DisplayManager displayManager;
    private boolean displayListenerRegistered;
    private final Handler displayHandler = new Handler(Looper.getMainLooper());

    private void hideSystemBars() {
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        controller.hide(WindowInsetsCompat.Type.systemBars());
    }

    private Display currentDisplay() {
        Display display = getWindow().getDecorView().getDisplay();
        return display != null ? display : getWindowManager().getDefaultDisplay();
    }

    private void preferGameFrameRate() {
        if (isFinishing() || isDestroyed()) return;
        // This is a window preference, never a system refresh-rate override.
        // Thermal limits, battery saver and user settings remain authoritative.
        try {
            Display display = currentDisplay();
            if (display == null || !display.isValid()) return;
            int modeId = 0;
            float refreshRate = 0f;
            if (Build.VERSION.SDK_INT >= 34) {
                // Android 14+ interprets this as a seamless content-rate hint;
                // the OS can use VRR or 60/120 Hz without changing resolution.
                refreshRate = GAME_FRAME_RATE;
            } else {
                // Older Android requires an advertised mode. Only consider the
                // current physical resolution, preferring 60, then 120/180 Hz.
                // Panels without an even multiple retain the system's choice.
                Display.Mode current = display.getMode();
                Display.Mode preferred = null;
                for (Display.Mode candidate : display.getSupportedModes()) {
                    if (candidate.getPhysicalWidth() != current.getPhysicalWidth()
                            || candidate.getPhysicalHeight() != current.getPhysicalHeight()) continue;
                    float rate = candidate.getRefreshRate();
                    int multiple = Math.round(rate / GAME_FRAME_RATE);
                    if (multiple < 1 || Math.abs(rate - multiple * GAME_FRAME_RATE) > 1f) continue;
                    if (preferred == null || rate < preferred.getRefreshRate()) preferred = candidate;
                }
                if (preferred != null) {
                    modeId = preferred.getModeId();
                    refreshRate = preferred.getRefreshRate();
                }
            }
            WindowManager.LayoutParams params = getWindow().getAttributes();
            if (params.preferredDisplayModeId != modeId || Math.abs(params.preferredRefreshRate - refreshRate) > 0.01f) {
                params.preferredDisplayModeId = modeId;
                params.preferredRefreshRate = refreshRate;
                getWindow().setAttributes(params);
            }
        } catch (RuntimeException error) {
            // Some OEM display services reject hints during display migration.
            // Rendering must remain usable under the system's default policy.
            Log.w("IsaacDisplay", "Display frame-rate preference unavailable", error);
        }
    }

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        displayManager = (DisplayManager) getSystemService(DISPLAY_SERVICE);
        hideSystemBars();
        preferGameFrameRate();
    }
    @Override public void onResume() {
        super.onResume();
        if (displayManager != null && !displayListenerRegistered) {
            displayManager.registerDisplayListener(this, displayHandler);
            displayListenerRegistered = true;
        }
        preferGameFrameRate();
    }
    @Override public void onPause() {
        if (displayManager != null && displayListenerRegistered) {
            displayManager.unregisterDisplayListener(this);
            displayListenerRegistered = false;
        }
        super.onPause();
    }
    @Override public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        preferGameFrameRate();
    }
    @Override public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            hideSystemBars();
            preferGameFrameRate();
        }
    }
    @Override public void onDisplayAdded(int displayId) { preferGameFrameRate(); }
    @Override public void onDisplayRemoved(int displayId) { preferGameFrameRate(); }
    @Override public void onDisplayChanged(int displayId) { preferGameFrameRate(); }
}
`);
  const gradle = 'android/app/build.gradle';
  let text = await readFile(gradle, 'utf8');
  text = text.replace(/versionCode \d+/, `versionCode ${buildNumber}`).replace(/versionName "[^"]+"/, `versionName "${packageVersion}"`);
  const signing = `\n// Release signing is supplied only through the CI environment.\nandroid {\n    signingConfigs {\n        release {\n            if (System.getenv('ANDROID_KEYSTORE_PATH')) {\n                storeFile file(System.getenv('ANDROID_KEYSTORE_PATH'))\n                storePassword System.getenv('ANDROID_KEYSTORE_PASSWORD')\n                keyAlias System.getenv('ANDROID_KEY_ALIAS')\n                keyPassword System.getenv('ANDROID_KEY_PASSWORD')\n            }\n        }\n    }\n    buildTypes { release {\n        if (System.getenv('ANDROID_KEYSTORE_PATH')) signingConfig signingConfigs.release\n    } }\n}\n`;
  if (!text.includes('// Release signing is supplied only')) text += signing;
  await writeFile(gradle, text);
  const properties = 'android/gradle.properties';
  await writeFile(properties, (await readFile(properties, 'utf8')).replace(/^org\.gradle\.jvmargs=.*$/m, 'org.gradle.jvmargs=-Xmx4096m'));
  const wrapper = 'android/gradle/wrapper/gradle-wrapper.properties';
  let wrapperText = await readFile(wrapper, 'utf8');
  if (!wrapperText.includes('gradle-8.14.3-')) throw new Error('Review the pinned Gradle version and checksum before updating Capacitor');
  wrapperText = wrapperText.replace('gradle-8.14.3-all.zip', 'gradle-8.14.3-bin.zip').replace(/^distributionSha256Sum=.*\n?/m, '');
  await writeFile(wrapper, wrapperText.trimEnd() + '\ndistributionSha256Sum=bd71102213493060956ec229d946beee57158dbd89d0e62b91bca0fa2c5f3531\n');
} else {
  const plist = 'ios/App/App/Info.plist';
  // CADisableMinimumFrameDurationOnPhone lifts the default iOS 15+ frame-rate
  // cap on web/third-party rendered content. Without it, ProMotion devices
  // throttle the WKWebView requestAnimationFrame supply (observed near 45 Hz),
  // which caps the game at ~45 FPS no matter how the browser pacing schedules.
  // This is the iOS counterpart to the Android preferredRefreshRate hint.
  const result = spawnSync('python3', ['-c', `import plistlib\np=${JSON.stringify(plist)}\nwith open(p,'rb') as f: d=plistlib.load(f)\nd['UISupportedInterfaceOrientations']=['UIInterfaceOrientationLandscapeLeft','UIInterfaceOrientationLandscapeRight']\nd['UISupportedInterfaceOrientations~ipad']=d['UISupportedInterfaceOrientations']\nd['UIFileSharingEnabled']=True\nd['LSSupportsOpeningDocumentsInPlace']=True\nd['UIStatusBarHidden']=True\nd['UIRequiredDeviceCapabilities']=['arm64']\nd['UIViewControllerBasedStatusBarAppearance']=False\nd['CADisableMinimumFrameDurationOnPhone']=True\nwith open(p,'wb') as f: plistlib.dump(d,f)\n`], {stdio: 'inherit'});
  if (result.status !== 0) throw new Error('Cannot configure native iOS Info.plist');
  const project = 'ios/App/App.xcodeproj/project.pbxproj';
  let text = await readFile(project, 'utf8');
  text = text.replace(/IPHONEOS_DEPLOYMENT_TARGET = [0-9.]+;/g, 'IPHONEOS_DEPLOYMENT_TARGET = 27.0;');
  text = text.replace(/CURRENT_PROJECT_VERSION = [0-9.]+;/g, `CURRENT_PROJECT_VERSION = ${buildNumber};`).replace(/MARKETING_VERSION = [0-9.]+;/g, `MARKETING_VERSION = ${packageVersion};`);
  if (!text.includes('/* PrivacyInfo.xcprivacy in Resources */')) {
    const reference = '49534141435052495641435931', buildFile = '49534141435052495641435932';
    text = text.replace('/* Begin PBXBuildFile section */', `/* Begin PBXBuildFile section */\n\t\t${buildFile} /* PrivacyInfo.xcprivacy in Resources */ = {isa = PBXBuildFile; fileRef = ${reference} /* PrivacyInfo.xcprivacy */; };`);
    text = text.replace('/* Begin PBXFileReference section */', `/* Begin PBXFileReference section */\n\t\t${reference} /* PrivacyInfo.xcprivacy */ = {isa = PBXFileReference; lastKnownFileType = text.xml; name = PrivacyInfo.xcprivacy; path = App/PrivacyInfo.xcprivacy; sourceTree = SOURCE_ROOT; };`);
    const before = text;
    text = text.replace(/(isa = PBXResourcesBuildPhase;[\s\S]*?files = \()/, `$1\n\t\t\t\t${buildFile} /* PrivacyInfo.xcprivacy in Resources */,`);
    if (text === before) throw new Error('Cannot attach the iOS privacy manifest to app resources');
  }
  await writeFile(project, text);
  await copyFile('PrivacyInfo.xcprivacy', 'ios/App/App/PrivacyInfo.xcprivacy');
  // Capacitor derives this platform from the Xcode deployment target on later
  // syncs, but emits .v27 with a 5.9 tools manifest. The enum requires 6.4;
  // the string initializer supports the same target with the pinned template.
  const swiftPackage = 'ios/App/CapApp-SPM/Package.swift';
  if (await exists(swiftPackage)) {
    const manifest = await readFile(swiftPackage, 'utf8');
    if (!/platforms: \[\.iOS\(/.test(manifest)) throw new Error('Review the generated Swift Package deployment target');
    await writeFile(swiftPackage, manifest.replace(/platforms: \[[^\n]+\],/, 'platforms: [.iOS("27.0")],'));
  }
  // Ask for 60Hz, but do not present another Metal layer. A second drawable
  // shares the GPU with WebGL and can stall the game thread. Low Power Mode
  // and thermal limits remain authoritative.
  await writeFile('ios/App/App/SceneDelegate.swift', `import UIKit
import Capacitor
import QuartzCore
import WebKit
import UniformTypeIdentifiers

class SceneDelegate: UIResponder, UIWindowSceneDelegate, WKScriptMessageHandler, UIDocumentPickerDelegate {
    var window: UIWindow?
    private var frameRateLink: CADisplayLink?
    private var folderPickerInstalled = false
    private var folderPickId: String?
    private let folderImportLimit = 256 * 1024 * 1024
    private let folderFileLimit = 128 * 1024 * 1024
    private let folderCountLimit = 10000

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = CAPBridgeViewController()
        window?.makeKeyAndVisible()

        preferFrameRate()
        installFolderPicker()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        preferFrameRate()
        frameRateLink?.isPaused = false
    }

    func sceneWillResignActive(_ scene: UIScene) {
        frameRateLink?.isPaused = true
    }

    private func preferFrameRate() {
        UIApplication.shared.isIdleTimerDisabled = true
        keepWebViewFromBouncing()
        let link = frameRateLink ?? CADisplayLink(target: self, selector: #selector(onDisplayTick))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 60, preferred: 60)
        link.isPaused = false
        if frameRateLink == nil {
            link.add(to: .main, forMode: .common)
            frameRateLink = link
        }
    }

    private func bridgeWebView() -> WKWebView? {
        (window?.rootViewController as? CAPBridgeViewController)?.webView
    }

    private func installFolderPicker() {
        guard !folderPickerInstalled, let webView = bridgeWebView() else { return }
        webView.configuration.userContentController.add(self, name: "isaacPickModFolder")
        folderPickerInstalled = true
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "isaacPickModFolder" else { return }
        let body = message.body as? [String: Any]
        let id = body?["id"] as? String ?? ""
        DispatchQueue.main.async {
            guard self.folderPickId == nil, !id.isEmpty, let presenter = self.window?.rootViewController else {
                self.finishFolderPick(id: id, error: "文件夹选择器正忙，请稍后再试。")
                return
            }
            self.folderPickId = id
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.folder], asCopy: false)
            picker.delegate = self
            picker.allowsMultipleSelection = false
            presenter.present(picker, animated: true)
        }
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        let id = folderPickId
        folderPickId = nil
        if let id { finishFolderPick(id: id, cancelled: true) }
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        let id = folderPickId
        folderPickId = nil
        guard let id, let url = urls.first else { return }
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let token = UUID().uuidString
                let files = try self.copyModFolder(url, token: token)
                DispatchQueue.main.async { self.finishFolderPick(id: id, token: token, files: files) }
            } catch {
                DispatchQueue.main.async { self.finishFolderPick(id: id, error: error.localizedDescription) }
            }
        }
    }

    private func copyModFolder(_ url: URL, token: String) throws -> [String] {
        let accessing = url.startAccessingSecurityScopedResource()
        defer { if accessing { url.stopAccessingSecurityScopedResource() } }
        let root = url.standardizedFileURL
        let caches = try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let destination = caches.appendingPathComponent("isaac-mod-import/\\(token)", isDirectory: true)
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
        guard let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey, .isDirectoryKey], options: [.skipsHiddenFiles]) else {
            throw NSError(domain: "IsaacDocuments", code: 1, userInfo: [NSLocalizedDescriptionKey: "无法读取所选文件夹。"])
        }
        var files: [String] = []
        var total = 0
        let rootPath = root.path
        while let item = enumerator.nextObject() as? URL {
            let values = try item.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey, .isDirectoryKey])
            if values.isSymbolicLink == true {
                throw NSError(domain: "IsaacDocuments", code: 2, userInfo: [NSLocalizedDescriptionKey: "Mod 不能包含符号链接。"])
            }
            if values.isDirectory == true || values.isRegularFile != true { continue }
            let size = values.fileSize ?? 0
            if size > folderFileLimit || total > folderImportLimit - size {
                throw NSError(domain: "IsaacDocuments", code: 3, userInfo: [NSLocalizedDescriptionKey: "Mod 超过 256 MiB 或单个文件超过 128 MiB。"])
            }
            let full = item.standardizedFileURL.path
            guard full.hasPrefix(rootPath + "/") else { continue }
            let relative = String(full.dropFirst(rootPath.count + 1))
            if relative.split(separator: "/").contains(where: { $0 == "__MACOSX" || $0 == ".git" || $0 == ".DS_Store" || $0.hasPrefix("._") }) { continue }
            if files.count >= folderCountLimit {
                throw NSError(domain: "IsaacDocuments", code: 4, userInfo: [NSLocalizedDescriptionKey: "请选择一个 Mod 文件夹（最多 10000 个文件）。"])
            }
            let target = destination.appendingPathComponent(relative)
            try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: item, to: target)
            files.append(relative)
            total += size
        }
        if files.isEmpty {
            throw NSError(domain: "IsaacDocuments", code: 5, userInfo: [NSLocalizedDescriptionKey: "Mod 文件夹中没有可导入的文件。"])
        }
        return files
    }

    private func finishFolderPick(id: String, token: String? = nil, files: [String] = [], cancelled: Bool = false, error: String? = nil) {
        guard let webView = bridgeWebView() else { return }
        var payload: [String: Any] = ["id": id]
        if cancelled { payload["cancelled"] = true }
        if let error { payload["error"] = error }
        if let token { payload["token"] = token; payload["files"] = files }
        guard let data = try? JSONSerialization.data(withJSONObject: payload), let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.isaacModFolderResult(\\(json))", completionHandler: nil)
    }

    private func keepWebViewFromBouncing() {
        guard let scroll = (window?.rootViewController as? CAPBridgeViewController)?.webView?.scrollView else { return }
        scroll.bounces = false
        scroll.alwaysBounceVertical = false
        scroll.alwaysBounceHorizontal = false
        scroll.contentInsetAdjustmentBehavior = .never
    }

    @objc private func onDisplayTick(_ link: CADisplayLink) {
    }

    func sceneDidDisconnect(_ scene: UIScene) {
        frameRateLink?.invalidate()
        frameRateLink = nil
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
`);
}
console.log(`Prepared ${platform}: bundled game resources, native DAT storage and Chinese launcher.`);
