package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

const developmentFormat = "isaac-j835-development-v2"

type developmentProject struct {
	Format string       `json:"format"`
	AppID  string       `json:"appId"`
	Target string       `json:"target"`
	Core   []fileRecord `json:"core"`
}

func loadDevelopment(rootPath string, verifyAll bool) (_ *bundle, err error) {
	rootPath, err = filepath.Abs(rootPath)
	if err != nil {
		return nil, err
	}
	if _, err = checkRegular(rootPath, "project.json"); err != nil {
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
	data, err := readMetadata(root, "project.json")
	if err != nil {
		return nil, err
	}
	var project developmentProject
	if err = json.Unmarshal(data, &project); err != nil {
		return nil, err
	}
	if project.Format != developmentFormat || project.AppID != appID || project.Target != gameTarget {
		return nil, errors.New("Unsupported project configuration version")
	}
	b := &bundle{RootPath: rootPath, Root: root, Allowed: map[string]string{}, Records: map[string]fileRecord{}, Development: true}
	b.DataPath = filepath.Join(filepath.Dir(rootPath), "userdata")
	b.RootID = identityForPath(b.DataPath)
	b.Package = packageRecord{AppID: appID, Format: developmentFormat, PackageID: developmentFormat}
	add := func(record fileRecord, verify bool) error {
		if _, exists := b.Records[record.Path]; exists {
			return fmt.Errorf("Duplicate file: %s", record.Path)
		}
		info, e := checkRegular(rootPath, record.Path)
		if e != nil {
			return e
		}
		if info.Size() != record.Size {
			return fmt.Errorf("File size mismatch: %s", record.Path)
		}
		if verify {
			hash, e := fileDigest(root, record.Path)
			if e != nil {
				return e
			}
			if !strings.EqualFold(hash, record.SHA256) {
				return fmt.Errorf("File checksum mismatch: %s", record.Path)
			}
		}
		b.Records[record.Path] = record
		return nil
	}
	if len(project.Core) != 2 {
		return nil, errors.New("The project must contain both game core files")
	}
	for _, record := range project.Core {
		if record.Path != "core/j835_game.mjs" && record.Path != "core/j835_game.wasm" {
			return nil, errors.New("Unsupported game core file")
		}
		if err = add(record, true); err != nil {
			return nil, err
		}
		b.Allowed["/"+strings.TrimPrefix(record.Path, "core/")] = record.Path
		b.Package.PackageID += "-" + record.SHA256
	}
	for route, file := range webFiles {
		if strings.HasPrefix(file, "j835_game.") {
			continue
		}
		name := "web/" + file
		if _, e := checkRegular(rootPath, name); e != nil {
			if route == "/" || route == "/app.mjs" || route == "/index.html" {
				return nil, e
			}
			continue
		}
		info, e := root.Stat(name)
		if e != nil {
			return nil, e
		}
		b.Records[name] = fileRecord{Path: name, Size: info.Size()}
		b.Allowed[route] = name
	}
	if _, err = checkRegular(rootPath, "asset-manifest.json"); err != nil {
		return nil, err
	}
	b.Manifest, err = readMetadata(root, "asset-manifest.json")
	if err != nil {
		return nil, err
	}
	var manifest assetManifest
	if err = json.Unmarshal(b.Manifest, &manifest); err != nil {
		return nil, err
	}
	if manifest.Target != gameTarget || len(manifest.Files) == 0 || len(manifest.Mods) != 0 {
		return nil, errors.New("The project must contain Repentance resources and no preinstalled Mods")
	}
	for _, asset := range manifest.Files {
		if !validRelative(asset.Path) {
			return nil, errors.New("Invalid asset path")
		}
		u, e := url.Parse(asset.URL)
		if e != nil || u.IsAbs() || u.Host != "" || u.RawQuery != "" || u.Fragment != "" || u.Path != "/assets/"+asset.Path {
			return nil, errors.New("Asset URLs must point to files within the project")
		}
		record := fileRecord{Path: "assets/" + asset.Path, Size: asset.Size, SHA256: asset.SHA256}
		if err = add(record, verifyAll); err != nil {
			return nil, err
		}
		b.Allowed[u.Path] = record.Path
	}
	digest, e := fileDigest(root, "asset-manifest.json")
	if e != nil {
		return nil, e
	}
	b.Package.PackageID += "-" + digest
	// Stable, bounded identity independent of the absolute folder location.
	b.Package.PackageID = identityForContent(b.Package.PackageID)
	return b, nil
}

func identityForContent(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
