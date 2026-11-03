package main

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func diskFixture(t *testing.T) *diskStore {
	t.Helper()
	s, err := openDiskStore(filepath.Join(t.TempDir(), "relocated folder", "userdata"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s
}
func diskRequest(s *diskStore, method, route string, body any, headers map[string]string) *httptest.ResponseRecorder {
	var encoded []byte
	if body != nil {
		encoded, _ = json.Marshal(body)
	}
	r := httptest.NewRequest(method, "http://127.0.0.1:8274"+route, bytes.NewReader(encoded))
	r.Header.Set("X-Isaac-Token", s.Token)
	for key, value := range headers {
		r.Header.Set(key, value)
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}
func diskPut(t *testing.T, s *diskStore, bucket, key string, value snapshot) string {
	t.Helper()
	w := diskRequest(s, "PUT", "/api/storage/"+bucket+"/"+key, value, nil)
	if w.Code != 200 {
		t.Fatalf("PUT %s %s: %d %s", bucket, key, w.Code, w.Body)
	}
	var result snapshot
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Revision == "" {
		t.Fatal("no persisted revision")
	}
	return result.Revision
}
func TestDiskNativeBytesAndRevisionConflict(t *testing.T) {
	s := diskFixture(t)
	native := []byte("ISAACNG_GSR0146\x00\xff\x01")
	value := snapshot{Files: []storedFile{{saveRoot + "gamestate1.dat", native}, {"data/example_mod/save1.dat", []byte("mod bytes")}}, Meta: json.RawMessage(`{"migrated":true}`)}
	absent := diskRequest(s, "GET", "/api/storage/saves/main", nil, nil)
	if absent.Code != 200 || !strings.Contains(absent.Body.String(), `"revision":""`) {
		t.Fatal(absent.Body.String())
	}
	revision := diskPut(t, s, "saves", "main", value)
	for name, wanted := range map[string][]byte{"saves/gamestate1.dat": native, "mod-data/example_mod/save1.dat": []byte("mod bytes")} {
		got, err := os.ReadFile(filepath.Join(s.Path, filepath.FromSlash(name)))
		if err != nil || !bytes.Equal(got, wanted) {
			t.Fatalf("real bytes %s: %q %v", name, got, err)
		}
	}
	value.Revision = revision
	value.Files[0].Data = []byte("changed")
	if err := os.WriteFile(filepath.Join(s.Path, "saves/gamestate1.dat"), []byte("externally edited"), 0600); err != nil {
		t.Fatal(err)
	}
	if got := diskRequest(s, "PUT", "/api/storage/saves/main", value, nil); got.Code != 409 {
		t.Fatalf("stale write accepted: %d %s", got.Code, got.Body)
	}
	got, _ := os.ReadFile(filepath.Join(s.Path, "saves/gamestate1.dat"))
	if string(got) != "externally edited" {
		t.Fatal("conflict overwrote external file")
	}
	read, err := s.readSnapshot("saves", "main")
	if err != nil || read.Revision == revision {
		t.Fatal("manual edit not included in revision", err)
	}
}
func TestDiskSettingsModsAndRemoval(t *testing.T) {
	s := diskFixture(t)
	diskPut(t, s, "settings", "main", snapshot{Files: []storedFile{{"settings.json", []byte(`{"touch":true}`)}, {"touch-layout.json", []byte(`{"version":1}`)}}, Meta: json.RawMessage(`{"kind":"settings"}`)})
	mod := snapshot{Files: []storedFile{{"main.lua", []byte("print('test')")}, {"resources/\u4e2d\u6587 file.xml", []byte("<test/>")}}, Meta: json.RawMessage(`{"id":"123","name":"test","enabled":true}`)}
	revision := diskPut(t, s, "mods", "123", mod)
	listed := diskRequest(s, "GET", "/api/mods", nil, nil)
	if listed.Code != 200 || !strings.Contains(listed.Body.String(), `"key":"123"`) {
		t.Fatalf("mod list %d %s", listed.Code, listed.Body)
	}
	if w := diskRequest(s, "DELETE", "/api/storage/mods/123", nil, map[string]string{"X-Isaac-Revision": "stale"}); w.Code != 409 {
		t.Fatal("stale delete accepted")
	}
	if w := diskRequest(s, "DELETE", "/api/storage/mods/123", nil, map[string]string{"X-Isaac-Revision": revision}); w.Code != 200 {
		t.Fatalf("delete %d %s", w.Code, w.Body)
	}
	if _, err := os.Stat(filepath.Join(s.Path, "mods/123")); !os.IsNotExist(err) {
		t.Fatal("mod directory not removed", err)
	}
}
func TestDiskAPIAuthPathsAndLock(t *testing.T) {
	s := diskFixture(t)
	if second, err := openDiskStore(s.Path); err == nil {
		second.Close()
		t.Fatal("second launcher lock accepted")
	}
	for _, headers := range []map[string]string{{"X-Isaac-Token": "wrong"}, {"Origin": "http://attacker.example"}, {"Sec-Fetch-Site": "cross-site"}} {
		w := diskRequest(s, "GET", "/api/storage/saves/main", nil, headers)
		if w.Code != 403 {
			t.Fatalf("unsafe read accepted: %d", w.Code)
		}
	}
	for _, name := range []string{"../outside.dat", "user/Documents/My Games/Binding of Isaac Repentance/../../secret.dat", "data/mod/main.lua", "data/mod/CON.txt", "user/Documents/My Games/Binding of Isaac Repentance/log.txt"} {
		value := snapshot{Files: []storedFile{{name, []byte("unsafe")}}}
		w := diskRequest(s, "PUT", "/api/storage/saves/main", value, nil)
		if w.Code != 400 {
			t.Fatalf("unsafe path %q accepted: %d %s", name, w.Code, w.Body)
		}
	}
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.MkdirAll(outside, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(s.Path, "saves/link")); err != nil {
		t.Fatal(err)
	}
	w := diskRequest(s, "PUT", "/api/storage/saves/main", snapshot{Files: []storedFile{{saveRoot + "link/save.dat", []byte("unsafe")}}}, nil)
	if w.Code != 500 {
		t.Fatalf("symlink was not blocked: %d %s", w.Code, w.Body)
	}
}
func TestDiskTransactionRecovery(t *testing.T) {
	s := diskFixture(t)
	revision := diskPut(t, s, "saves", "main", snapshot{Files: []storedFile{{saveRoot + "gamestate1.dat", []byte("old")}}, Meta: json.RawMessage(`{}`)})
	// Simulate interruption after moving the old save directory and installing a new one.
	if err := ensureDirectory(s.Root, transactionDir+"/old"); err != nil {
		t.Fatal(err)
	}
	if err := ensureDirectory(s.Root, transactionDir+"/new"); err != nil {
		t.Fatal(err)
	}
	journal := transactionJournal{Targets: []transactionTarget{{"saves", true}, {"mod-data", true}, {".storage/saves-main.json", true}}}
	if err := s.writeJournal(journal); err != nil {
		t.Fatal(err)
	}
	if err := s.Root.Rename("saves", transactionDir+"/old/0"); err != nil {
		t.Fatal(err)
	}
	if err := ensureDirectory(s.Root, "saves"); err != nil {
		t.Fatal(err)
	}
	if err := s.Root.WriteFile("saves/gamestate1.dat", []byte("unfinished"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := s.recoverTransaction(); err != nil {
		t.Fatal(err)
	}
	read, err := s.readSnapshot("saves", "main")
	if err != nil || read.Revision != revision {
		t.Fatalf("incomplete transaction not rolled back: %v", err)
	}
}
