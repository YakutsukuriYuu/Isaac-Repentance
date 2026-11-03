// The launcher serves local game resources and persists player data beside them
// or in an application wrapper's explicit writable data directory.
// It never searches Steam or listens outside loopback.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

const (
	appID         = "isaac-j835-portable"
	packageFormat = "isaac-j835-portable-v1"
	gameTarget    = "Repentance 1.7.9b.J835"
	metadataLimit = 8 << 20
)

type fileRecord struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

type packageRecord struct {
	Format    string       `json:"format"`
	AppID     string       `json:"appId"`
	PackageID string       `json:"packageId"`
	Files     []fileRecord `json:"files"`
}

type assetRecord struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256,omitempty"`
	URL    string `json:"url"`
}

type modRecord struct {
	ID     string        `json:"id"`
	Name   string        `json:"name"`
	Folder string        `json:"folder"`
	Files  []assetRecord `json:"files"`
}

type assetManifest struct {
	Target string        `json:"target"`
	Files  []assetRecord `json:"files"`
	Mods   []modRecord   `json:"mods"`
}

type healthRecord struct {
	AppID            string `json:"appId"`
	PackageID        string `json:"packageId"`
	Target           string `json:"target"`
	RootID           string `json:"rootId,omitempty"`
	Storage          string `json:"storage,omitempty"`
	Mode             string `json:"mode,omitempty"`
	PreinstalledMods int    `json:"preinstalledMods"`
}

var webFiles = map[string]string{
	"/":                   "index.html",
	"/index.html":         "index.html",
	"/app.mjs":            "app.mjs",
	"/save_helpers.mjs":   "save_helpers.mjs",
	"/styles.css":         "styles.css",
	"/touch_controls.mjs": "touch_controls.mjs",
	"/touch_layout.mjs":   "touch_layout.mjs",
	"/fps_metrics.mjs":    "fps_metrics.mjs",
	"/mod_helpers.mjs":    "mod_helpers.mjs",
	"/disk_storage.mjs":   "disk_storage.mjs",
	"/j835_game.mjs":      "j835_game.mjs",
	"/j835_game.wasm":     "j835_game.wasm",
}

// Paths are POSIX relative paths in the archive, portable to Windows as well.
func validRelative(name string) bool {
	if name == "" || name == "." || path.IsAbs(name) || path.Clean(name) != name || strings.ContainsAny(name, "\\\x00<>:\"|?*") {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if part == ".." || part == "." || strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") {
			return false
		}
		for _, c := range part {
			if c < 32 {
				return false
			}
		}
		base := strings.ToUpper(strings.SplitN(part, ".", 2)[0])
		if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" ||
			(len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) && base[3] >= '1' && base[3] <= '9') {
			return false
		}
	}
	return true
}

// Initial checks reject symlinks and junctions resolved outside the package;
// os.Root additionally confines every later file open against path replacement.
func checkRegular(root, relative string) (os.FileInfo, error) {
	if !validRelative(relative) {
		return nil, fmt.Errorf("invalid package path %q", relative)
	}
	current := root
	parts := strings.Split(relative, "/")
	var info os.FileInfo
	for i, component := range parts {
		current = filepath.Join(current, component)
		var err error
		info, err = os.Lstat(current)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", relative, err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("%s: links are not allowed in a portable package", relative)
		}
		if i < len(parts)-1 && !info.IsDir() {
			return nil, fmt.Errorf("%s: parent is not a directory", relative)
		}
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%s: not a regular file", relative)
	}
	return info, nil
}

func readMetadata(root *os.Root, name string) ([]byte, error) {
	f, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, metadataLimit+1))
	if len(b) > metadataLimit {
		return nil, fmt.Errorf("%s exceeds metadata size limit", name)
	}
	return b, err
}

func fileDigest(root *os.Root, name string) (string, error) {
	f, err := root.Open(name)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err = io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

type bundle struct {
	RootPath    string
	DataPath    string
	RootID      string
	Development bool
	Storage     *diskStore
	Root        *os.Root
	Package     packageRecord
	Manifest    []byte
	Allowed     map[string]string
	Records     map[string]fileRecord
}

func loadBundle(rootPath string, verifyAll bool) (_ *bundle, err error) {
	if _, e := os.Lstat(filepath.Join(rootPath, "project.json")); e == nil {
		return loadDevelopment(rootPath, verifyAll)
	}
	rootPath, err = filepath.Abs(rootPath)
	if err != nil {
		return nil, err
	}
	if _, err = checkRegular(rootPath, "package.json"); err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return nil, err
	}
	defer func() {
		if err != nil {
			root.Close()
		}
	}()
	data, err := readMetadata(root, "package.json")
	if err != nil {
		return nil, err
	}
	b := &bundle{RootPath: rootPath, Root: root, Allowed: make(map[string]string), Records: make(map[string]fileRecord)}
	b.DataPath = filepath.Join(rootPath, "userdata")
	b.RootID = identityForPath(b.DataPath)
	if err = json.Unmarshal(data, &b.Package); err != nil {
		return nil, fmt.Errorf("package.json: %w", err)
	}
	if b.Package.AppID != appID || b.Package.Format != packageFormat || len(b.Package.PackageID) == 0 || len(b.Package.PackageID) > 128 || strings.ContainsAny(b.Package.PackageID, "\r\n\t ") {
		return nil, fmt.Errorf("package.json has an unsupported format or package identity")
	}
	if len(b.Package.Files) == 0 || len(b.Package.Files) > 100000 {
		return nil, fmt.Errorf("package.json has an invalid file count")
	}
	caseNames := make(map[string]bool)
	for _, record := range b.Package.Files {
		if !validRelative(record.Path) || record.Path == "package.json" || record.Size < 0 {
			return nil, fmt.Errorf("invalid file record %q", record.Path)
		}
		key := strings.ToLower(record.Path)
		if caseNames[key] {
			return nil, fmt.Errorf("duplicate or case-colliding package path %q", record.Path)
		}
		caseNames[key] = true
		decoded, decodeErr := hex.DecodeString(record.SHA256)
		if decodeErr != nil || len(decoded) != sha256.Size {
			return nil, fmt.Errorf("invalid SHA256 for %s", record.Path)
		}
		info, statErr := checkRegular(rootPath, record.Path)
		if statErr != nil {
			return nil, statErr
		}
		if info.Size() != record.Size {
			return nil, fmt.Errorf("%s: file size changed (expected %d, got %d)", record.Path, record.Size, info.Size())
		}
		if verifyAll || record.Path == "asset-manifest.json" || !strings.Contains(record.Path, "/") && (strings.HasSuffix(record.Path, ".mjs") || strings.HasSuffix(record.Path, ".wasm") || record.Path == "index.html") {
			digest, digestErr := fileDigest(root, record.Path)
			if digestErr != nil {
				return nil, digestErr
			}
			if !strings.EqualFold(digest, record.SHA256) {
				return nil, fmt.Errorf("%s: SHA256 mismatch; re-extract the original package", record.Path)
			}
		}
		b.Records[record.Path] = record
	}
	for _, required := range []string{"index.html", "app.mjs", "j835_game.mjs", "j835_game.wasm", "asset-manifest.json"} {
		if _, ok := b.Records[required]; !ok {
			return nil, fmt.Errorf("package.json is missing %s", required)
		}
	}
	for requestPath, file := range webFiles {
		if _, ok := b.Records[file]; ok {
			b.Allowed[requestPath] = file
		}
	}
	b.Manifest, err = readMetadata(root, "asset-manifest.json")
	if err != nil {
		return nil, err
	}
	var manifest assetManifest
	if err = json.Unmarshal(b.Manifest, &manifest); err != nil {
		return nil, fmt.Errorf("asset-manifest.json: %w", err)
	}
	if manifest.Target != gameTarget || len(manifest.Files) == 0 {
		return nil, fmt.Errorf("asset-manifest.json has the wrong target or no resources")
	}
	assets := append([]assetRecord(nil), manifest.Files...)
	modIDs := make(map[string]bool)
	for _, mod := range manifest.Mods {
		if mod.ID == "" || modIDs[mod.ID] || !validRelative(mod.Folder) || strings.Contains(mod.Folder, "/") {
			return nil, fmt.Errorf("invalid mod metadata %q", mod.ID)
		}
		modIDs[mod.ID] = true
		for _, asset := range mod.Files {
			if !strings.HasPrefix(asset.Path, "mods/"+mod.Folder+"/") {
				return nil, fmt.Errorf("mod %s contains an asset outside its folder", mod.ID)
			}
		}
		assets = append(assets, mod.Files...)
	}
	for _, asset := range assets {
		if !validRelative(asset.Path) {
			return nil, fmt.Errorf("invalid guest asset path %q", asset.Path)
		}
		u, parseErr := url.Parse(asset.URL)
		if parseErr != nil || u.IsAbs() || u.Host != "" || u.RawQuery != "" || u.Fragment != "" || u.Path != "/assets/"+asset.Path {
			return nil, fmt.Errorf("asset %s has a non-local or mismatched URL", asset.Path)
		}
		file := "assets/" + asset.Path
		record, exists := b.Records[file]
		if !exists || record.Size != asset.Size {
			return nil, fmt.Errorf("asset %s is missing or disagrees with package.json", asset.Path)
		}
		if _, exists = b.Allowed[u.Path]; exists {
			return nil, fmt.Errorf("duplicate asset URL %q", u.Path)
		}
		b.Allowed[u.Path] = file
	}
	return b, nil
}

func contentType(name string) string {
	switch path.Ext(name) {
	case ".html":
		return "text/html; charset=utf-8"
	case ".mjs", ".js":
		return "text/javascript; charset=utf-8"
	case ".wasm":
		return "application/wasm"
	case ".json":
		return "application/json; charset=utf-8"
	case ".a":
		// Isaac resource archives are opaque game data, not Unix ar libraries.
		// Do not let the host's MIME database change their served type.
		return "application/octet-stream"
	}
	if result := mime.TypeByExtension(path.Ext(name)); result != "" {
		return result
	}
	return "application/octet-stream"
}

func (b *bundle) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if strings.HasPrefix(r.URL.Path, "/api/") && b.Storage != nil {
		b.Storage.ServeHTTP(w, r)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "read-only game package", http.StatusMethodNotAllowed)
		return
	}
	host, _, splitErr := net.SplitHostPort(r.Host)
	if splitErr != nil {
		host = r.Host
	}
	if host != "127.0.0.1" && host != "localhost" {
		http.Error(w, "loopback host required", http.StatusForbidden)
		return
	}
	if r.URL.Path == "/health.json" {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		mode := "portable-package"
		if b.Development {
			mode = "portable-development"
		}
		storage := "browser"
		if b.Storage != nil {
			storage = "disk"
		}
		data, _ := json.Marshal(healthRecord{AppID: appID, PackageID: b.Package.PackageID, Target: gameTarget, RootID: b.RootID, Storage: storage, Mode: mode})
		w.Header().Set("Content-Length", fmt.Sprint(len(data)))
		if r.Method == http.MethodGet {
			w.Write(data)
		}
		return
	}
	if r.URL.Path == "/asset-manifest.json" {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Content-Length", fmt.Sprint(len(b.Manifest)))
		if r.Method == http.MethodGet {
			w.Write(b.Manifest)
		}
		return
	}
	file, ok := b.Allowed[r.URL.Path]
	if !ok {
		http.NotFound(w, r)
		return
	}
	f, err := b.Root.Open(file)
	if err != nil {
		http.Error(w, "package file is unavailable", http.StatusNotFound)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || (info.Size() != b.Records[file].Size && !(b.Development && strings.HasPrefix(file, "web/"))) {
		http.Error(w, "package file changed; restart with --check", http.StatusConflict)
		return
	}
	w.Header().Set("Content-Type", contentType(file))
	// ServeContent provides RFC range/HEAD handling without directory redirects,
	// listings, filename guessing, or automatic access to other package files.
	http.ServeContent(w, r, path.Base(file), info.ModTime(), f)
}

func locateRoot(explicit, executable string) (string, error) {
	if explicit != "" {
		return filepath.Abs(explicit)
	}
	realExe, err := filepath.EvalSymlinks(executable)
	if err != nil {
		return "", err
	}
	directory := filepath.Dir(realExe)
	for _, candidate := range []string{directory, filepath.Dir(directory)} {
		for _, marker := range []string{"project.json", "package.json"} {
			if info, statErr := os.Stat(filepath.Join(candidate, marker)); statErr == nil && info.Mode().IsRegular() {
				return candidate, nil
			}
		}
	}
	return "", errors.New("Project configuration was not found. Keep the complete project folder and run its startup script.")
}

func matchingServer(client *http.Client, baseURL, packageID string, rootID ...string) bool {
	response, err := client.Get(baseURL + "health.json")
	if err != nil {
		return false
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return false
	}
	var health healthRecord
	if json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&health) != nil {
		return false
	}
	return health.AppID == appID && health.PackageID == packageID && health.Target == gameTarget && (len(rootID) == 0 || health.RootID == rootID[0])
}

func openBrowser(address string) error {
	if runtime.GOOS == "darwin" {
		for _, name := range []string{"Google Chrome", "Microsoft Edge"} {
			if err := exec.Command("/usr/bin/open", "-a", name, address).Run(); err == nil {
				return nil
			}
		}
		return errors.New("Chrome or Edge was not found. Install a compatible browser, then open the address shown above.")
	}
	var candidates []string
	if runtime.GOOS == "windows" {
		for _, browserPath := range []string{`Google\Chrome\Application\chrome.exe`, `Microsoft\Edge\Application\msedge.exe`} {
			for _, variable := range []string{"ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"} {
				if directory := os.Getenv(variable); directory != "" {
					candidates = append(candidates, filepath.Join(directory, browserPath))
				}
			}
		}
		candidates = append(candidates, "chrome.exe", "msedge.exe")
	} else {
		candidates = []string{"google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"}
	}
	for _, candidate := range candidates {
		program, err := exec.LookPath(candidate)
		if err != nil {
			continue
		}
		command := exec.Command(program, address)
		if err := command.Start(); err == nil {
			command.Process.Release()
			return nil
		}
	}
	return errors.New("Chrome or Edge was not found. Open the address above in a compatible browser.")
}

type launcherOptions struct {
	Root, DataDir, ReadyFile string
	Port                     int
	NoOpen, Verify, Check    bool
}

func parseOptions(args []string) (launcherOptions, error) {
	var options launcherOptions
	flags := flag.NewFlagSet("isaac-launcher", flag.ContinueOnError)
	flags.StringVar(&options.Root, "root", "", "Portable project directory; defaults to the launcher location")
	flags.StringVar(&options.DataDir, "data-dir", "", "Absolute writable user-data directory; defaults to the portable project userdata")
	flags.StringVar(&options.ReadyFile, "ready-file", "", "Absolute, initially absent JSON file for an application wrapper's startup notification")
	flags.IntVar(&options.Port, "port", 8274, "Loopback port; 0 chooses an available port")
	flags.BoolVar(&options.NoOpen, "no-open", false, "Start the server without opening a browser")
	flags.BoolVar(&options.Verify, "verify", false, "Verify all file SHA-256 hashes before starting")
	flags.BoolVar(&options.Check, "check", false, "Verify all file SHA-256 hashes and exit")
	if err := flags.Parse(args); err != nil {
		return options, err
	}
	if flags.NArg() != 0 || options.Port < 0 || options.Port > 65535 {
		return options, errors.New("Invalid arguments: port must be 0..65535. Use --help to list options.")
	}
	for name, value := range map[string]string{"data-dir": options.DataDir, "ready-file": options.ReadyFile} {
		if value != "" && !filepath.IsAbs(value) {
			return options, fmt.Errorf("--%s must be an absolute path", name)
		}
	}
	return options, nil
}

func run() error {
	options, err := parseOptions(os.Args[1:])
	if errors.Is(err, flag.ErrHelp) {
		return nil
	}
	if err != nil {
		return err
	}
	stop, cancel := signal.NotifyContext(context.Background(), shutdownSignals()...)
	defer cancel()
	return runLauncher(stop, options)
}

func runLauncher(stop context.Context, options launcherOptions) error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	rootPath, err := locateRoot(options.Root, executable)
	if err != nil {
		return err
	}
	fmt.Println("Checking portable project files...")
	b, err := loadBundle(rootPath, options.Verify || options.Check)
	if err != nil {
		return fmt.Errorf("The portable project is incomplete or files have changed: %w", err)
	}
	defer b.Root.Close()
	if options.Check {
		fmt.Printf("Verification passed: %d files, package %s\n", len(b.Records), b.Package.PackageID)
		return nil
	}
	if options.DataDir != "" {
		b.DataPath = filepath.Clean(options.DataDir)
		b.RootID = identityForPath(b.DataPath)
	}
	address := net.JoinHostPort("127.0.0.1", fmt.Sprint(options.Port))
	baseURL := "http://" + address + "/"
	listener, err := net.Listen("tcp4", address)
	if err != nil {
		if options.Port == 0 {
			return fmt.Errorf("Unable to bind an available loopback port: %w", err)
		}
		client := &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{Proxy: nil}, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
		if options.ReadyFile != "" || !matchingServer(client, baseURL, b.Package.PackageID, b.RootID) {
			return fmt.Errorf("Port %d is in use by another program or project. Close the previous game server and try again. The launcher will not connect to another project data directory. Original error: %w", options.Port, err)
		}
		fmt.Println("The same project is already running:", baseURL)
		if !options.NoOpen {
			if openErr := openBrowser(baseURL); openErr != nil {
				fmt.Println(openErr)
			}
		}
		return nil
	}
	defer listener.Close()
	baseURL = "http://" + listener.Addr().String() + "/"
	b.Storage, err = openDiskStore(b.DataPath)
	if err != nil {
		return err
	}
	defer b.Storage.Close()
	b.RootID = b.Storage.ID
	server := &http.Server{Handler: b, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	fmt.Println("Game URL:", baseURL)
	fmt.Println("User data:", b.DataPath)
	fmt.Println("Click Start Game. Keep this window open while playing. Press Ctrl+C to stop the local server.")
	result := make(chan error, 1)
	go func() { result <- server.Serve(listener) }()
	defer server.Close()
	if options.ReadyFile != "" {
		if err := publishReady(options.ReadyFile, readyRecord{URL: baseURL, RootID: b.RootID, PackageID: b.Package.PackageID, PID: os.Getpid()}); err != nil {
			return fmt.Errorf("Writing application startup notification: %w", err)
		}
		defer os.Remove(options.ReadyFile)
	}
	if !options.NoOpen {
		if openErr := openBrowser(baseURL); openErr != nil {
			fmt.Println(openErr)
		}
	}
	select {
	case serveErr := <-result:
		if errors.Is(serveErr, http.ErrServerClosed) {
			return nil
		}
		return serveErr
	case <-stop.Done():
		ctx, timeout := context.WithTimeout(context.Background(), 3*time.Second)
		defer timeout()
		return server.Shutdown(ctx)
	}
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "Unable to start the game:", err)
		os.Exit(1)
	}
}

// Stable ordering is used by tests and package tooling when listing routes.
func allowedPaths(b *bundle) []string {
	result := make([]string, 0, len(b.Allowed))
	for requestPath := range b.Allowed {
		result = append(result, requestPath)
	}
	sort.Strings(result)
	return result
}
