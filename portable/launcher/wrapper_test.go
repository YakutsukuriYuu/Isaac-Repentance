package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestWrapperOptionsAndPortableDefaults(t *testing.T) {
	options, err := parseOptions(nil)
	if err != nil || options.Port != 8274 || options.DataDir != "" || options.ReadyFile != "" || options.NoOpen {
		t.Fatalf("portable defaults changed: %+v, %v", options, err)
	}
	for _, args := range [][]string{{"--port", "-1"}, {"--port", "65536"}, {"--data-dir", "relative"}, {"--ready-file", "relative"}, {"unexpected"}} {
		if _, err := parseOptions(args); err == nil {
			t.Errorf("invalid options accepted: %q", args)
		}
	}
	if options, err := parseOptions([]string{"--port", "0", "--no-open"}); err != nil || options.Port != 0 || !options.NoOpen {
		t.Fatalf("random loopback port rejected: %+v, %v", options, err)
	}
}

func TestReadyFileIsAtomicPrivateAndExclusive(t *testing.T) {
	name := filepath.Join(t.TempDir(), "ready.json")
	record := readyRecord{URL: "http://127.0.0.1:12345/", RootID: "root", PackageID: "package", PID: 100}
	if err := publishReady(name, record); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if err := json.Unmarshal(data, &value); err != nil || len(value) != 4 || value["url"] != record.URL || value["token"] != nil {
		t.Fatalf("invalid or sensitive startup notification: %s (%v)", data, err)
	}
	info, err := os.Stat(name)
	if err != nil || runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
		t.Fatalf("ready notification is not private: %v, %v", info, err)
	}
	if err := publishReady(name, readyRecord{PID: 200}); err == nil {
		t.Fatal("an existing ready notification was overwritten")
	}
	after, _ := os.ReadFile(name)
	if !bytes.Equal(data, after) {
		t.Fatal("failed ready publication changed the existing file")
	}
	entries, err := os.ReadDir(filepath.Dir(name))
	if err != nil || len(entries) != 1 {
		t.Fatalf("temporary ready files were not cleaned: %v, %v", entries, err)
	}
}

func TestWrapperReadOnlyProjectExternalSavesAndRandomPort(t *testing.T) {
	root := developmentFixture(t)
	if err := os.Chmod(root, 0555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(root, 0755) })
	dataDir := filepath.Join(t.TempDir(), "application-support", "userdata")
	readyFile := filepath.Join(t.TempDir(), "ready.json")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() {
		result <- runLauncher(ctx, launcherOptions{Root: root, DataDir: dataDir, ReadyFile: readyFile, Port: 0, NoOpen: true, Verify: true})
	}()
	var record readyRecord
	deadline := time.Now().Add(5 * time.Second)
	for {
		data, err := os.ReadFile(readyFile)
		if err == nil {
			if err := json.Unmarshal(data, &record); err != nil {
				t.Fatalf("partially published notification: %v", err)
			}
			break
		}
		select {
		case err := <-result:
			t.Fatalf("server failed before readiness: %v", err)
		default:
		}
		if !errors.Is(err, os.ErrNotExist) || time.Now().After(deadline) {
			t.Fatalf("no startup notification: %v", err)
		}
		time.Sleep(5 * time.Millisecond)
	}
	client := &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{Proxy: nil}}
	if !strings.HasPrefix(record.URL, "http://127.0.0.1:") || strings.Contains(record.URL, ":0/") || !matchingServer(client, record.URL, record.PackageID, record.RootID) {
		t.Fatalf("invalid readiness identity: %+v", record)
	}
	response, err := client.Get(record.URL + "api/session")
	if err != nil {
		t.Fatal(err)
	}
	var session map[string]string
	err = json.NewDecoder(response.Body).Decode(&session)
	response.Body.Close()
	if err != nil || response.StatusCode != 200 || session["rootId"] != record.RootID || session["dataPath"] != dataDir && identityForPath(session["dataPath"]) != identityForPath(dataDir) {
		t.Fatalf("external storage session is wrong: %v, %v", session, err)
	}
	fileBytes := []byte{0, 255, 1, 2, 128, 42}
	body, _ := json.Marshal(snapshot{Revision: "", Files: []storedFile{{Path: saveRoot + "persistentgamedata1.dat", Data: fileBytes}}, Meta: json.RawMessage(`{"initialized":true}`)})
	req, _ := http.NewRequest("PUT", record.URL+"api/storage/saves/main", bytes.NewReader(body))
	req.Header.Set("X-Isaac-Token", session["token"])
	req.Header.Set("Content-Type", "application/json")
	response, err = client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	reply, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatalf("save write failed: %d %s", response.StatusCode, reply)
	}
	saved, err := os.ReadFile(filepath.Join(dataDir, "saves", "persistentgamedata1.dat"))
	if err != nil || !bytes.Equal(saved, fileBytes) {
		t.Fatalf("native save bytes differ: %v, %v", saved, err)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(root), "userdata")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("application attempted to write beside its read-only project: %v", err)
	}
	cancel()
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("server did not shut down")
	}
	if _, err := os.Stat(readyFile); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stale ready file left after shutdown: %v", err)
	}
	// A normal shutdown must release the process lock without losing the save.
	store, err := openDiskStore(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	loaded, err := store.readSnapshot("saves", "main")
	if err != nil || len(loaded.Files) != 1 || !bytes.Equal(loaded.Files[0].Data, fileBytes) {
		t.Fatalf("save did not survive server restart: %+v, %v", loaded, err)
	}
}

func TestReadyPublicationFailureStopsServerAndReleasesStorage(t *testing.T) {
	root := developmentFixture(t)
	dataDir := filepath.Join(t.TempDir(), "userdata")
	readyFile := filepath.Join(t.TempDir(), "already-used.json")
	if err := os.WriteFile(readyFile, []byte("existing"), 0600); err != nil {
		t.Fatal(err)
	}
	err := runLauncher(context.Background(), launcherOptions{Root: root, DataDir: dataDir, ReadyFile: readyFile, Port: 0, NoOpen: true})
	if err == nil || !strings.Contains(err.Error(), "startup notification") {
		t.Fatalf("ready publication failure was not reported: %v", err)
	}
	data, _ := os.ReadFile(readyFile)
	if string(data) != "existing" {
		t.Fatal("existing ready file was replaced")
	}
	store, err := openDiskStore(dataDir)
	if err != nil {
		t.Fatalf("failed startup retained the data lock: %v", err)
	}
	store.Close()
}
