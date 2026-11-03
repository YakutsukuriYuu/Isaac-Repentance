package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
)

const saveRoot = "user/Documents/My Games/Binding of Isaac Repentance/"

var modKey = regexp.MustCompile(`^(?:[1-9][0-9]{0,19}|local-[0-9a-f]{24})$`)
var errConflict = errors.New("Local files changed in another window or program. Export your current save before reloading to avoid overwriting newer data.")

type storedFile struct {
	Path string `json:"path"`
	Data []byte `json:"base64"`
}
type snapshot struct {
	Revision string          `json:"revision"`
	Files    []storedFile    `json:"files"`
	Meta     json.RawMessage `json:"meta"`
}
type modListing struct {
	Key      string          `json:"key"`
	Revision string          `json:"revision"`
	Meta     json.RawMessage `json:"meta"`
}
type diskStore struct {
	Root            *os.Root
	Path, ID, Token string
	lock            *os.File
	mu              sync.Mutex
}

func identityForPath(p string) string {
	if canonical, err := filepath.EvalSymlinks(p); err == nil {
		p = canonical
	}
	if runtimeWindows {
		p = strings.ToLower(p)
	}
	sum := sha256.Sum256([]byte(filepath.Clean(p)))
	return hex.EncodeToString(sum[:])
}
func openDiskStore(directory string) (_ *diskStore, err error) {
	directory, err = filepath.Abs(directory)
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(directory, 0755); err != nil {
		return nil, err
	}
	directory, err = filepath.EvalSymlinks(directory)
	if err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil, err
	}
	s := &diskStore{Root: root, Path: directory, ID: identityForPath(directory)}
	defer func() {
		if err != nil {
			s.Close()
		}
	}()
	if err = ensureDirectory(root, ".storage"); err != nil {
		return nil, err
	}
	s.lock, err = root.OpenFile(".storage/launcher.lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = lockFile(s.lock); err != nil {
		return nil, fmt.Errorf("This userdata directory is already in use by another launcher: %w", err)
	}
	secret := make([]byte, 32)
	if _, err = rand.Read(secret); err != nil {
		return nil, err
	}
	s.Token = hex.EncodeToString(secret)
	if err = s.recoverTransaction(); err != nil {
		return nil, fmt.Errorf("Recovering an interrupted local save: %w", err)
	}
	for _, name := range []string{"saves", "mod-data", "mods", "settings"} {
		if err = ensureDirectory(root, name); err != nil {
			return nil, err
		}
	}
	return s, nil
}
func (s *diskStore) Close() {
	if s.lock != nil {
		unlockFile(s.lock)
		s.lock.Close()
	}
	if s.Root != nil {
		s.Root.Close()
	}
}
func ensureDirectory(root *os.Root, name string) error {
	current := ""
	for _, part := range strings.Split(name, "/") {
		current = path.Join(current, part)
		info, err := root.Lstat(current)
		if errors.Is(err, fs.ErrNotExist) {
			if err = root.Mkdir(current, 0755); err != nil {
				return err
			}
			continue
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return fmt.Errorf("A directory contains a link or a non-directory entry: %s", current)
		}
	}
	return nil
}
func checkDataPath(root *os.Root, name string, mayMiss bool) error {
	if !validRelative(name) {
		return fmt.Errorf("Invalid local path: %s", name)
	}
	parts := strings.Split(name, "/")
	current := ""
	for i, part := range parts {
		current = path.Join(current, part)
		info, err := root.Lstat(current)
		if errors.Is(err, fs.ErrNotExist) && mayMiss {
			return nil
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("Local data cannot contain symbolic links: %s", current)
		}
		if i < len(parts)-1 && !info.IsDir() {
			return fmt.Errorf("The parent path is not a directory: %s", current)
		}
	}
	return nil
}
func storageLimits(bucket string) (int64, int) {
	switch bucket {
	case "saves":
		return 32 << 20, 2048
	case "settings":
		return 1 << 20, 2
	case "mods":
		return 256 << 20, 10000
	}
	return 0, 0
}
func validStorageKey(bucket, key string) bool {
	return (bucket == "saves" || bucket == "settings") && key == "main" || bucket == "mods" && modKey.MatchString(key)
}
func saveDiskPath(virtual string) (string, error) {
	if !validRelative(virtual) || len(virtual) > 512 || len(strings.Split(virtual, "/")) > 16 {
		return "", errors.New("Invalid save path")
	}
	basename := path.Base(virtual)
	if regexp.MustCompile(`(?i)^(log|debug|crash)([._-]|$)`).MatchString(basename) {
		return "", errors.New("Log files are not save files")
	}
	if strings.HasPrefix(virtual, saveRoot) {
		if ext := strings.ToLower(path.Ext(virtual)); ext != ".dat" && ext != ".ini" {
			return "", errors.New("Unsupported game save file type")
		}
		return "saves/" + strings.TrimPrefix(virtual, saveRoot), nil
	}
	for _, version := range []string{"Afterbirth+", "Afterbirth", "Rebirth"} {
		prefix := "user/Documents/My Games/Binding of Isaac " + version + "/"
		if strings.HasPrefix(virtual, prefix) {
			if ext := strings.ToLower(path.Ext(virtual)); ext != ".dat" && ext != ".ini" {
				return "", errors.New("Unsupported game save file type")
			}
			return "saves/legacy/" + version + "/" + strings.TrimPrefix(virtual, prefix), nil
		}
	}
	if strings.HasPrefix(virtual, "data/") && strings.Count(virtual, "/") >= 2 {
		switch strings.ToLower(path.Ext(virtual)) {
		case ".dat", ".ini", ".json", ".cfg", ".sav", ".bin", ".save", ".txt":
			return "mod-data/" + strings.TrimPrefix(virtual, "data/"), nil
		}
	}
	return "", errors.New("Unsupported save path")
}
func saveVirtualPath(disk string) (string, error) {
	if strings.HasPrefix(disk, "mod-data/") {
		return "data/" + strings.TrimPrefix(disk, "mod-data/"), nil
	}
	if strings.HasPrefix(disk, "saves/legacy/") {
		parts := strings.SplitN(strings.TrimPrefix(disk, "saves/legacy/"), "/", 2)
		if len(parts) == 2 {
			return "user/Documents/My Games/Binding of Isaac " + parts[0] + "/" + parts[1], nil
		}
	}
	if strings.HasPrefix(disk, "saves/") {
		return saveRoot + strings.TrimPrefix(disk, "saves/"), nil
	}
	return "", errors.New("Unknown save directory")
}
func diskFilePath(bucket, key, name string) (string, error) {
	if !validRelative(name) || len(name) > 512 || len(strings.Split(name, "/")) > 24 {
		return "", errors.New("Invalid file path")
	}
	switch bucket {
	case "saves":
		return saveDiskPath(name)
	case "settings":
		if name != "settings.json" && name != "touch-layout.json" {
			return "", errors.New("Invalid settings filename")
		}
		return "settings/" + name, nil
	case "mods":
		return "mods/" + key + "/files/" + name, nil
	}
	return "", errors.New("Invalid storage bucket")
}
func metadataPath(bucket, key string) string {
	if bucket == "mods" {
		return "mods/" + key + "/metadata.json"
	}
	return ".storage/" + bucket + "-" + key + ".json"
}
func snapshotRoots(bucket, key string) []string {
	switch bucket {
	case "saves":
		return []string{"saves", "mod-data"}
	case "settings":
		return []string{"settings"}
	case "mods":
		return []string{"mods/" + key + "/files"}
	}
	return nil
}
func normalizeMeta(meta json.RawMessage) (json.RawMessage, error) {
	if len(meta) == 0 || string(meta) == "null" {
		return json.RawMessage("null"), nil
	}
	if len(meta) > 65536 {
		return nil, errors.New("Metadata exceeds 64 KiB")
	}
	var obj map[string]any
	if json.Unmarshal(meta, &obj) != nil || obj == nil {
		return nil, errors.New("Metadata must be a JSON object")
	}
	return json.Marshal(obj)
}
func (s *diskStore) readSnapshot(bucket, key string) (snapshot, error) {
	result := snapshot{Files: []storedFile{}, Meta: json.RawMessage("null")}
	limit, countLimit := storageLimits(bucket)
	var total int64
	metaName := metadataPath(bucket, key)
	hasMeta := false
	if err := checkDataPath(s.Root, metaName, false); err == nil {
		info, _ := s.Root.Stat(metaName)
		if info == nil || !info.Mode().IsRegular() || info.Size() > 65536 {
			return result, errors.New("Invalid local metadata")
		}
		data, err := s.Root.ReadFile(metaName)
		if err != nil {
			return result, err
		}
		result.Meta, err = normalizeMeta(data)
		if err != nil {
			return result, err
		}
		hasMeta = true
	} else if !errors.Is(err, fs.ErrNotExist) {
		return result, err
	}
	for _, folder := range snapshotRoots(bucket, key) {
		if err := checkDataPath(s.Root, folder, false); errors.Is(err, fs.ErrNotExist) {
			continue
		} else if err != nil {
			return result, err
		}
		err := fs.WalkDir(s.Root.FS(), folder, func(name string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if entry.Type()&os.ModeSymlink != 0 {
				return fmt.Errorf("The userdata directory contains a symbolic link: %s", name)
			}
			if entry.IsDir() {
				return nil
			}
			if entry.Name() == ".DS_Store" || strings.HasPrefix(entry.Name(), "._") {
				return nil
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			if !info.Mode().IsRegular() {
				return errors.New("User data contains a special file")
			}
			total += info.Size()
			if info.Size() > 128<<20 || total > limit || len(result.Files) >= countLimit {
				return errors.New("Local data exceeds the storage limit")
			}
			var virtual string
			switch bucket {
			case "saves":
				virtual, err = saveVirtualPath(name)
			case "settings":
				virtual = strings.TrimPrefix(name, "settings/")
			case "mods":
				virtual = strings.TrimPrefix(name, folder+"/")
			}
			if err != nil {
				return err
			}
			if mapped, e := diskFilePath(bucket, key, virtual); e != nil || mapped != name {
				return fmt.Errorf("The directory contains an unsupported data file: %s", name)
			}
			data, err := s.Root.ReadFile(name)
			if err != nil {
				return err
			}
			result.Files = append(result.Files, storedFile{Path: virtual, Data: data})
			return nil
		})
		if err != nil {
			return result, err
		}
	}
	sort.Slice(result.Files, func(i, j int) bool { return result.Files[i].Path < result.Files[j].Path })
	if hasMeta || len(result.Files) > 0 {
		result.Revision = snapshotRevision(result)
	}
	return result, nil
}

// Hash raw bytes with explicit lengths: no base64-sized duplicate is allocated.
func snapshotRevision(value snapshot) string {
	sort.Slice(value.Files, func(i, j int) bool { return value.Files[i].Path < value.Files[j].Path })
	h := sha256.New()
	var size [8]byte
	field := func(data []byte) {
		binary.LittleEndian.PutUint64(size[:], uint64(len(data)))
		h.Write(size[:])
		h.Write(data)
	}
	field(value.Meta)
	for _, file := range value.Files {
		field([]byte(file.Path))
		field(file.Data)
	}
	return hex.EncodeToString(h.Sum(nil))
}
func validateSnapshot(bucket, key string, value *snapshot) error {
	limit, countLimit := storageLimits(bucket)
	if len(value.Files) > countLimit {
		return errors.New("Too many files")
	}
	meta, err := normalizeMeta(value.Meta)
	if err != nil {
		return err
	}
	value.Meta = meta
	var total int64
	seen := map[string]bool{}
	directories := map[string]string{}
	for _, file := range value.Files {
		disk, err := diskFilePath(bucket, key, file.Path)
		if err != nil {
			return err
		}
		folded := strings.ToLower(disk)
		if seen[folded] {
			return errors.New("Duplicate or case-colliding filenames")
		}
		seen[folded] = true
		parts := strings.Split(disk, "/")
		for i := 1; i < len(parts); i++ {
			directory := strings.Join(parts[:i], "/")
			k := strings.ToLower(directory)
			if old, ok := directories[k]; ok && old != directory {
				return errors.New("Case-colliding directory names")
			}
			directories[k] = directory
		}
		total += int64(len(file.Data))
		if len(file.Data) > 128<<20 || total > limit {
			return errors.New("Data exceeds the size limit")
		}
	}
	for name := range seen {
		if _, ok := directories[name]; ok {
			return errors.New("A file and directory share the same name")
		}
	}
	return nil
}
func writeSynced(root *os.Root, name string, data []byte) error {
	if err := ensureDirectory(root, path.Dir(name)); err != nil {
		return err
	}
	if err := checkDataPath(root, name, true); err != nil {
		return err
	}
	f, err := root.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	return closeErr
}

type transactionTarget struct {
	Path   string `json:"path"`
	HadOld bool   `json:"hadOld"`
}
type transactionJournal struct {
	Targets   []transactionTarget `json:"targets"`
	Committed bool                `json:"committed"`
}

const transactionDir = ".storage/transaction"

func (s *diskStore) writeJournal(j transactionJournal) error {
	data, _ := json.Marshal(j)
	temporary := transactionDir + "/journal.next"
	_ = s.Root.Remove(temporary)
	if err := writeSynced(s.Root, temporary, data); err != nil {
		return err
	}
	return s.Root.Rename(temporary, transactionDir+"/journal.json")
}
func (s *diskStore) recoverTransaction() error {
	if err := checkDataPath(s.Root, transactionDir, false); errors.Is(err, fs.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	data, err := s.Root.ReadFile(transactionDir + "/journal.json")
	if errors.Is(err, fs.ErrNotExist) {
		return s.Root.RemoveAll(transactionDir)
	}
	if err != nil {
		return err
	}
	var j transactionJournal
	if json.Unmarshal(data, &j) != nil {
		return errors.New("The interrupted-write recovery journal is corrupt. Preserve the backups and userdata directory.")
	}
	if !j.Committed {
		for i := len(j.Targets) - 1; i >= 0; i-- {
			target := j.Targets[i]
			if !validRelative(target.Path) || !allowedTransactionTarget(target.Path) {
				return errors.New("Invalid transaction recovery path")
			}
			backup := fmt.Sprintf("%s/old/%d", transactionDir, i)
			staged := fmt.Sprintf("%s/new/%d", transactionDir, i)
			if _, e := s.Root.Lstat(backup); e == nil {
				if err = s.Root.RemoveAll(target.Path); err != nil {
					return err
				}
				if err = s.Root.Rename(backup, target.Path); err != nil {
					return err
				}
			} else if !errors.Is(e, fs.ErrNotExist) {
				return e
			} else if !target.HadOld {
				if _, e = s.Root.Lstat(staged); errors.Is(e, fs.ErrNotExist) {
					if err = s.Root.RemoveAll(target.Path); err != nil {
						return err
					}
				} else if e != nil {
					return e
				}
			}
		}
	}
	return s.Root.RemoveAll(transactionDir)
}
func allowedTransactionTarget(p string) bool {
	return p == "saves" || p == "mod-data" || p == "settings" || p == ".storage/saves-main.json" || p == ".storage/settings-main.json" || strings.HasPrefix(p, "mods/") && modKey.MatchString(strings.TrimPrefix(p, "mods/"))
}
func (s *diskStore) commit(bucket, key string, value snapshot, remove bool) error {
	if err := s.recoverTransaction(); err != nil {
		return err
	}
	targets := snapshotRoots(bucket, key)
	if bucket == "mods" {
		targets = []string{"mods/" + key}
	} else {
		targets = append(targets, metadataPath(bucket, key))
	}
	if err := ensureDirectory(s.Root, transactionDir+"/new"); err != nil {
		return err
	}
	if err := ensureDirectory(s.Root, transactionDir+"/old"); err != nil {
		return err
	}
	journal := transactionJournal{}
	for i, target := range targets {
		info, err := s.Root.Lstat(target)
		exists := err == nil
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		if exists && info.Mode()&os.ModeSymlink != 0 {
			return errors.New("The destination path contains a symbolic link")
		}
		journal.Targets = append(journal.Targets, transactionTarget{target, exists})
		if remove {
			continue
		}
		stage := fmt.Sprintf("%s/new/%d", transactionDir, i)
		if target == metadataPath(bucket, key) {
			if err = writeSynced(s.Root, stage, value.Meta); err != nil {
				return err
			}
			continue
		}
		if err = ensureDirectory(s.Root, stage); err != nil {
			return err
		}
		for _, file := range value.Files {
			disk, err := diskFilePath(bucket, key, file.Path)
			if err != nil {
				return err
			}
			if strings.HasPrefix(disk, target+"/") {
				if err = writeSynced(s.Root, stage+strings.TrimPrefix(disk, target), file.Data); err != nil {
					return err
				}
			}
		}
		if bucket == "mods" {
			if err = writeSynced(s.Root, stage+"/metadata.json", value.Meta); err != nil {
				return err
			}
		}
	}
	if err := s.writeJournal(journal); err != nil {
		return err
	}
	failed := func(err error) error {
		if rollback := s.recoverTransaction(); rollback != nil {
			return fmt.Errorf("Save failed (%v), recovery failed (%v); the transaction directory has been preserved", err, rollback)
		}
		return err
	}
	for i, target := range journal.Targets {
		if err := ensureDirectory(s.Root, path.Dir(target.Path)); err != nil {
			return failed(err)
		}
		if target.HadOld {
			if err := s.Root.Rename(target.Path, fmt.Sprintf("%s/old/%d", transactionDir, i)); err != nil {
				return failed(err)
			}
		}
		if !remove {
			if err := s.Root.Rename(fmt.Sprintf("%s/new/%d", transactionDir, i), target.Path); err != nil {
				return failed(err)
			}
		}
	}
	journal.Committed = true
	if err := s.writeJournal(journal); err != nil {
		return failed(err)
	}
	// At this point all files are durable. Cleanup failure can safely be retried on next launch.
	_ = s.Root.RemoveAll(transactionDir)
	return nil
}
func (s *diskStore) listMods() ([]modListing, error) {
	result := []modListing{}
	entries, err := fs.ReadDir(s.Root.FS(), "mods")
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if entry.Name() == ".DS_Store" {
			continue
		}
		if !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 || !modKey.MatchString(entry.Name()) {
			return nil, errors.New("The mods directory contains an unsupported directory or link")
		}
		value, err := s.readSnapshot("mods", entry.Name())
		if err != nil {
			return nil, err
		}
		result = append(result, modListing{entry.Name(), value.Revision, value.Meta})
	}
	return result, nil
}
func (s *diskStore) checkModQuota(key string, value snapshot) error {
	entries, err := fs.ReadDir(s.Root.FS(), "mods")
	if err != nil {
		return err
	}
	count := 1
	total := int64(0)
	for _, file := range value.Files {
		total += int64(len(file.Data))
	}
	for _, entry := range entries {
		if entry.Name() == key || entry.Name() == ".DS_Store" {
			continue
		}
		if !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 || !modKey.MatchString(entry.Name()) {
			return errors.New("The mods directory contains invalid entries")
		}
		count++
		err = fs.WalkDir(s.Root.FS(), "mods/"+entry.Name()+"/files", func(_ string, e fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if e.Type()&os.ModeSymlink != 0 {
				return errors.New("Mod files contain a link")
			}
			if !e.IsDir() {
				info, err := e.Info()
				if err != nil {
					return err
				}
				total += info.Size()
			}
			return nil
		})
		if err != nil {
			return err
		}
	}
	if count > 100 || total > 512<<20 {
		return errors.New("Installed Mods exceed the limit of 100 Mods or 512 MiB")
	}
	return nil
}
func apiError(w http.ResponseWriter, code int, err error) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
}
func apiJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(value)
}
func (s *diskStore) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	host, _, err := net.SplitHostPort(r.Host)
	if err != nil {
		host = r.Host
	}
	origin := r.Header.Get("Origin")
	fetchSite := r.Header.Get("Sec-Fetch-Site")
	if (host != "127.0.0.1" && host != "localhost") || (origin != "" && origin != "http://"+r.Host) || (fetchSite != "" && fetchSite != "same-origin" && fetchSite != "none") {
		apiError(w, 403, errors.New("Only local same-origin requests are allowed"))
		return
	}
	if r.URL.Path == "/api/session" {
		if r.Method != http.MethodGet {
			apiError(w, 405, errors.New("Only GET is supported"))
			return
		}
		apiJSON(w, map[string]string{"storage": "disk", "token": s.Token, "rootId": s.ID, "dataPath": s.Path})
		return
	}
	if r.Header.Get("X-Isaac-Token") != s.Token {
		apiError(w, 403, errors.New("The local storage session has expired. Reload the page."))
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if r.URL.Path == "/api/mods" {
		if r.Method != http.MethodGet {
			apiError(w, 405, errors.New("Only GET is supported"))
			return
		}
		mods, err := s.listMods()
		if err != nil {
			apiError(w, 500, err)
			return
		}
		apiJSON(w, mods)
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/storage/"), "/")
	if !strings.HasPrefix(r.URL.Path, "/api/storage/") || len(parts) != 2 || !validStorageKey(parts[0], parts[1]) {
		apiError(w, 404, errors.New("Storage path not found"))
		return
	}
	bucket, key := parts[0], parts[1]
	switch r.Method {
	case http.MethodGet:
		value, err := s.readSnapshot(bucket, key)
		if err != nil {
			apiError(w, 500, err)
			return
		}
		apiJSON(w, value)
	case http.MethodPut:
		maxBytes, _ := storageLimits(bucket)
		reader := http.MaxBytesReader(w, r.Body, maxBytes*4/3+4<<20)
		decoder := json.NewDecoder(reader)
		decoder.DisallowUnknownFields()
		var value snapshot
		if err := decoder.Decode(&value); err != nil {
			apiError(w, 400, fmt.Errorf("Invalid storage request: %w", err))
			return
		}
		if decoder.Decode(new(any)) != io.EOF {
			apiError(w, 400, errors.New("The request contains trailing data"))
			return
		}
		if err := validateSnapshot(bucket, key, &value); err != nil {
			apiError(w, 400, err)
			return
		}
		old, err := s.readSnapshot(bucket, key)
		if err != nil {
			apiError(w, 500, err)
			return
		}
		if value.Revision != old.Revision {
			apiError(w, 409, errConflict)
			return
		}
		if bucket == "mods" {
			if err = s.checkModQuota(key, value); err != nil {
				apiError(w, 400, err)
				return
			}
		}
		newRevision := snapshotRevision(value)
		if newRevision != old.Revision {
			if err = s.commit(bucket, key, value, false); err != nil {
				apiError(w, 500, err)
				return
			}
		}
		apiJSON(w, map[string]string{"revision": newRevision})
	case http.MethodDelete:
		if bucket != "mods" {
			apiError(w, 405, errors.New("Only Mod removal is supported"))
			return
		}
		old, err := s.readSnapshot(bucket, key)
		if err != nil {
			apiError(w, 500, err)
			return
		}
		if r.Header.Get("X-Isaac-Revision") != old.Revision {
			apiError(w, 409, errConflict)
			return
		}
		if old.Revision != "" {
			if err = s.commit(bucket, key, snapshot{}, true); err != nil {
				apiError(w, 500, err)
				return
			}
		}
		apiJSON(w, map[string]string{"revision": ""})
	default:
		apiError(w, 405, errors.New("Unsupported storage operation"))
	}
}
