package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"mime"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fixture(t *testing.T) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), "portable \u4e2d\u6587 path with spaces")
	if err := os.MkdirAll(root, 0755); err != nil {
		t.Fatal(err)
	}
	resources := []assetRecord{
		{Path: "isaac-ng.exe.unpacked.exe", Size: 10},
		{Path: "resources/packed/data.a", Size: 10},
		{Path: "resources/\u4e2d\u6587 #file.txt", Size: 10},
	}
	for i := range resources {
		resources[i].URL = (&url.URL{Path: "/assets/" + resources[i].Path}).String()
	}
	modAsset := assetRecord{Path: "mods/example mod/main.lua", Size: 10, URL: "/assets/mods/example%20mod/main.lua"}
	manifest := assetManifest{Target: gameTarget, Files: resources, Mods: []modRecord{{ID: "123", Name: "Example", Folder: "example mod", Files: []assetRecord{modAsset}}}}
	manifestBytes, _ := json.Marshal(manifest)
	contents := map[string][]byte{
		"index.html":          []byte("<!doctype html><title>test package</title>"),
		"app.mjs":             []byte("export const smoke = true;"),
		"save_helpers.mjs":    []byte("export const saveSmoke = true;"),
		"j835_game.mjs":       []byte("export default function(){}"),
		"j835_game.wasm":      []byte("\x00asm\x01\x00\x00\x00"),
		"asset-manifest.json": manifestBytes,
		"private-notes.txt":   []byte("not an HTTP resource"),
	}
	for _, asset := range append(resources, modAsset) {
		contents["assets/"+asset.Path] = []byte("0123456789")
	}
	metadata := packageRecord{Format: packageFormat, AppID: appID, PackageID: "test-content-identity"}
	for name, data := range contents {
		filename := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(filename), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filename, data, 0644); err != nil {
			t.Fatal(err)
		}
		h := sha256.Sum256(data)
		metadata.Files = append(metadata.Files, fileRecord{Path: name, Size: int64(len(data)), SHA256: hex.EncodeToString(h[:])})
	}
	data, _ := json.Marshal(metadata)
	if err := os.WriteFile(filepath.Join(root, "package.json"), data, 0644); err != nil {
		t.Fatal(err)
	}
	return root
}

func openFixture(t *testing.T) *bundle {
	t.Helper()
	b, err := loadBundle(fixture(t), true)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { b.Root.Close() })
	return b
}

func request(b *bundle, method, requestPath, byteRange string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://127.0.0.1:8274"+requestPath, nil)
	if byteRange != "" {
		r.Header.Set("Range", byteRange)
	}
	w := httptest.NewRecorder()
	b.ServeHTTP(w, r)
	return w
}

func TestRelocatedPackageAndHTTPAssets(t *testing.T) {
	b := openFixture(t)
	for _, test := range []struct{ path, mime string }{
		{"/", "text/html; charset=utf-8"},
		{"/index.html", "text/html; charset=utf-8"},
		{"/app.mjs", "text/javascript; charset=utf-8"},
		{"/save_helpers.mjs", "text/javascript; charset=utf-8"},
		{"/j835_game.wasm", "application/wasm"},
		{"/assets/resources/packed/data.a", "application/octet-stream"},
		{"/assets/resources/%E4%B8%AD%E6%96%87%20%23file.txt", "text/plain; charset=utf-8"},
		{"/assets/mods/example%20mod/main.lua", ""},
	} {
		w := request(b, "GET", test.path, "")
		if w.Code != 200 {
			t.Fatalf("%s: got %d: %s", test.path, w.Code, w.Body.String())
		}
		if test.mime != "" && w.Header().Get("Content-Type") != test.mime {
			t.Errorf("%s MIME: %s", test.path, w.Header().Get("Content-Type"))
		}
		if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("missing local package headers")
		}
	}
	for _, route := range []string{"/package.json", "/private-notes.txt", "/launcher-binaries/server.exe", "/assets/../package.json", "/assets/%2e%2e/package.json", "/assets/", "/unknown"} {
		if w := request(b, "GET", route, ""); w.Code != 404 {
			t.Errorf("unlisted %s: %d", route, w.Code)
		}
	}
	if w := request(b, "POST", "/app.mjs", ""); w.Code != 405 {
		t.Errorf("write request accepted: %d", w.Code)
	}
	r := httptest.NewRequest("GET", "http://attacker.example/app.mjs", nil)
	w := httptest.NewRecorder()
	b.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Errorf("non-loopback Host accepted: %d", w.Code)
	}
}

func TestGameArchiveMIMEIgnoresHostDatabase(t *testing.T) {
	// Linux commonly maps .a to Unix archive files; macOS may not. These game
	// archives must have the same binary response type on both hosts.
	if err := mime.AddExtensionType(".a", "application/x-archive"); err != nil {
		t.Fatal(err)
	}
	if got := contentType("resources/packed/repentance.a"); got != "application/octet-stream" {
		t.Fatalf("host MIME database changed game resource type: %s", got)
	}
}

func TestHeadAndRange(t *testing.T) {
	b := openFixture(t)
	const asset = "/assets/resources/packed/data.a"
	w := request(b, "HEAD", asset, "")
	if w.Code != 200 || w.Body.Len() != 0 || w.Header().Get("Content-Length") != "10" {
		t.Fatalf("HEAD: %+v %s", w.Result(), w.Body.String())
	}
	for _, test := range []struct{ rangeValue, body, contentRange string }{
		{"bytes=2-5", "2345", "bytes 2-5/10"},
		{"bytes=7-", "789", "bytes 7-9/10"},
		{"bytes=-3", "789", "bytes 7-9/10"},
	} {
		w = request(b, "GET", asset, test.rangeValue)
		if w.Code != 206 || w.Body.String() != test.body || w.Header().Get("Content-Range") != test.contentRange {
			t.Errorf("%s: status %d body %q range %s", test.rangeValue, w.Code, w.Body.String(), w.Header().Get("Content-Range"))
		}
	}
	w = request(b, "HEAD", asset, "bytes=2-5")
	if w.Code != 206 || w.Body.Len() != 0 || w.Header().Get("Content-Length") != "4" {
		t.Error("HEAD Range response is wrong")
	}
	if w = request(b, "GET", asset, "bytes=100-200"); w.Code != 416 {
		t.Errorf("bad range returned %d", w.Code)
	}
}

func TestPackageCorruptionAndManifestEscape(t *testing.T) {
	for _, filename := range []string{"app.mjs", "j835_game.wasm", "asset-manifest.json"} {
		t.Run(filename, func(t *testing.T) {
			root := fixture(t)
			file := filepath.Join(root, filename)
			old, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(file, []byte(strings.Repeat("x", len(old))), 0644); err != nil {
				t.Fatal(err)
			}
			if b, err := loadBundle(root, false); err == nil {
				b.Root.Close()
				t.Fatal("core corruption was not rejected")
			}
		})
	}
	t.Run("asset_same_size_full_check", func(t *testing.T) {
		root := fixture(t)
		if err := os.WriteFile(filepath.Join(root, "assets/resources/packed/data.a"), []byte("aaaaaaaaaa"), 0644); err != nil {
			t.Fatal(err)
		}
		b, err := loadBundle(root, false)
		if err != nil {
			t.Fatal("default size-only asset check unexpectedly failed:", err)
		}
		b.Root.Close()
		if b, err = loadBundle(root, true); err == nil {
			b.Root.Close()
			t.Fatal("full asset SHA check failed to reject corruption")
		}
	})
	t.Run("missing_asset", func(t *testing.T) {
		root := fixture(t)
		if err := os.Remove(filepath.Join(root, "assets/resources/packed/data.a")); err != nil {
			t.Fatal(err)
		}
		if b, err := loadBundle(root, false); err == nil {
			b.Root.Close()
			t.Fatal("missing asset accepted")
		}
	})
	for _, badPath := range []string{"../outside", "/absolute", "a\\b", "CON.txt", "nul", "dir/trailing.", "dir/trailing ", "a:b"} {
		if validRelative(badPath) {
			t.Errorf("nonportable or escaping path accepted: %q", badPath)
		}
	}
	for _, badURL := range []string{"https://example.com/resources/packed/data.a", "//example.com/asset", "/assets/resources/packed/data.a?x=1", "/assets/wrong"} {
		t.Run(badURL, func(t *testing.T) {
			root := fixture(t)
			rewriteManifest(t, root, func(m *assetManifest) { m.Files[1].URL = badURL })
			if b, err := loadBundle(root, false); err == nil {
				b.Root.Close()
				t.Fatal("external/mismatched asset URL accepted")
			}
		})
	}
}

func rewriteManifest(t *testing.T, root string, modify func(*assetManifest)) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(root, "asset-manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest assetManifest
	if err = json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	modify(&manifest)
	data, err = json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(root, "asset-manifest.json"), data, 0644); err != nil {
		t.Fatal(err)
	}
	h := sha256.Sum256(data)
	metadataData, err := os.ReadFile(filepath.Join(root, "package.json"))
	if err != nil {
		t.Fatal(err)
	}
	var metadata packageRecord
	if err = json.Unmarshal(metadataData, &metadata); err != nil {
		t.Fatal(err)
	}
	for i := range metadata.Files {
		if metadata.Files[i].Path == "asset-manifest.json" {
			metadata.Files[i].SHA256 = hex.EncodeToString(h[:])
			metadata.Files[i].Size = int64(len(data))
		}
	}
	metadataData, err = json.Marshal(metadata)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(root, "package.json"), metadataData, 0644); err != nil {
		t.Fatal(err)
	}
}

func TestLinksCannotEscapePackage(t *testing.T) {
	root := fixture(t)
	outside := filepath.Join(t.TempDir(), "outside.a")
	if err := os.WriteFile(outside, []byte("0123456789"), 0644); err != nil {
		t.Fatal(err)
	}
	asset := filepath.Join(root, "assets/resources/packed/data.a")
	if err := os.Remove(asset); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, asset); err != nil {
		t.Skip("symlink unavailable:", err)
	}
	if b, err := loadBundle(root, false); err == nil {
		b.Root.Close()
		t.Fatal("symlink accepted in portable package")
	}
	// Also replace a validated file while a server is running. os.Root must not
	// permit a later symlink replacement to turn an asset into an arbitrary read.
	b := openFixture(t)
	asset = filepath.Join(b.RootPath, "assets/resources/packed/data.a")
	if err := os.Remove(asset); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, asset); err != nil {
		t.Fatal(err)
	}
	w := request(b, "GET", "/assets/resources/packed/data.a", "")
	if w.Code != 404 {
		t.Fatalf("changed symlink leaked out of root: %d %q", w.Code, w.Body.String())
	}
}

func TestRootFromBinaryIndependentOfCWD(t *testing.T) {
	root := fixture(t)
	directory := filepath.Join(root, "launcher-binaries")
	if err := os.Mkdir(directory, 0755); err != nil {
		t.Fatal(err)
	}
	executable := filepath.Join(directory, "game-server")
	if err := os.WriteFile(executable, []byte("test"), 0755); err != nil {
		t.Fatal(err)
	}
	got, err := locateRoot("", executable)
	canonicalRoot, canonicalErr := filepath.EvalSymlinks(root)
	if canonicalErr != nil {
		t.Fatal(canonicalErr)
	}
	if err != nil || got != canonicalRoot {
		t.Fatalf("root=%q err=%v", got, err)
	}
	got, err = locateRoot(root, executable)
	if err != nil || got != root {
		t.Fatalf("explicit root=%q err=%v", got, err)
	}
}

func TestExistingServerIdentityOverHTTP(t *testing.T) {
	b := openFixture(t)
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &httptest.Server{Listener: listener, Config: &http.Server{Handler: b}}
	server.Start()
	defer server.Close()
	if !matchingServer(server.Client(), server.URL+"/", b.Package.PackageID) {
		t.Fatal("same package was not reusable")
	}
	if matchingServer(server.Client(), server.URL+"/", "different-package") {
		t.Fatal("different package accepted on same origin")
	}
	for _, endpoint := range []string{"/health.json", "/asset-manifest.json"} {
		response, err := server.Client().Head(server.URL + endpoint)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != 200 || len(body) != 0 || response.Header.Get("Content-Length") == "" {
			t.Errorf("HEAD %s was not complete", endpoint)
		}
	}
}

func developmentFixture(t *testing.T) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), "portable-project", "project")
	if err := os.MkdirAll(root, 0755); err != nil {
		t.Fatal(err)
	}
	contents := map[string][]byte{"web/index.html": []byte("<title>portable development</title>"), "web/app.mjs": []byte("export const value=1;"), "web/fps_metrics.mjs": []byte("export const fps=60;"), "web/styles.css": []byte("body{color:red}"), "core/j835_game.mjs": []byte("export default()=>{}"), "core/j835_game.wasm": []byte("\x00asm\x01\x00\x00\x00"), "assets/isaac-ng.exe.unpacked.exe": []byte("test fixture exe"), "assets/resources/data.a": []byte("test fixture resource")}
	project := developmentProject{Format: developmentFormat, AppID: appID, Target: gameTarget}
	manifest := assetManifest{Target: gameTarget, Mods: []modRecord{}}
	for name, data := range contents {
		filename := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(filename), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filename, data, 0644); err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(data)
		hash := hex.EncodeToString(sum[:])
		if strings.HasPrefix(name, "core/") {
			project.Core = append(project.Core, fileRecord{Path: name, Size: int64(len(data)), SHA256: hash})
		}
		if strings.HasPrefix(name, "assets/") {
			manifest.Files = append(manifest.Files, assetRecord{Path: strings.TrimPrefix(name, "assets/"), Size: int64(len(data)), SHA256: hash, URL: "/" + name})
		}
	}
	for name, value := range map[string]any{"project.json": project, "asset-manifest.json": manifest} {
		data, _ := json.Marshal(value)
		if err := os.WriteFile(filepath.Join(root, name), data, 0644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}
func TestDevelopmentLayoutLiveSourceAndRootIdentity(t *testing.T) {
	root := developmentFixture(t)
	b, err := loadBundle(root, true)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Root.Close()
	if !b.Development || b.DataPath != filepath.Join(filepath.Dir(root), "userdata") {
		t.Fatal("wrong development data path")
	}
	for _, route := range []string{"/", "/app.mjs", "/fps_metrics.mjs", "/styles.css", "/j835_game.wasm", "/assets/resources/data.a"} {
		if w := request(b, "GET", route, ""); w.Code != 200 {
			t.Fatalf("%s: %d %s", route, w.Code, w.Body)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "web/app.mjs"), []byte("export const editedWithoutPackaging=true;"), 0644); err != nil {
		t.Fatal(err)
	}
	w := request(b, "GET", "/app.mjs", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), "editedWithoutPackaging") {
		t.Fatalf("live source editing broken: %d %s", w.Code, w.Body)
	}
	other := developmentFixture(t)
	otherBundle, err := loadBundle(other, true)
	if err != nil {
		t.Fatal(err)
	}
	defer otherBundle.Root.Close()
	if b.RootID == otherBundle.RootID {
		t.Fatal("copied projects shared root identity")
	}
	if err := os.WriteFile(filepath.Join(root, "assets/resources/data.a"), []byte("test fixture resourcE"), 0644); err != nil {
		t.Fatal(err)
	}
	if corrupt, err := loadBundle(root, true); err == nil {
		corrupt.Root.Close()
		t.Fatal("asset integrity check accepted corruption")
	}
}
