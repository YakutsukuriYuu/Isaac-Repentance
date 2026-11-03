package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// This file announces an owned server, never credentials. Application wrappers
// create the containing private temporary directory and verify /health.json.
type readyRecord struct {
	URL       string `json:"url"`
	RootID    string `json:"rootId"`
	PackageID string `json:"packageId"`
	PID       int    `json:"pid"`
}

func publishReady(filename string, record readyRecord) error {
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(filename), ".isaac-ready-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if _, err = file.Write(append(data, '\n')); err != nil {
		return err
	}
	if err = file.Sync(); err != nil {
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	// Link makes the already complete 0600 file visible atomically, and fails
	// exclusively if the parent supplied a stale or already used destination.
	if err = os.Link(file.Name(), filename); err != nil {
		return fmt.Errorf("ready file must be absent and on a filesystem supporting hard links: %w", err)
	}
	return nil
}
