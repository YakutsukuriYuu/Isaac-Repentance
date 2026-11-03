//go:build windows

package main

import (
	"os"
	"syscall"
	"unsafe"
)

const runtimeWindows = true

func shutdownSignals() []os.Signal { return []os.Signal{os.Interrupt} }

var kernel = syscall.NewLazyDLL("kernel32.dll")
var lockProc = kernel.NewProc("LockFileEx")
var unlockProc = kernel.NewProc("UnlockFileEx")

func lockFile(file *os.File) error {
	var overlapped syscall.Overlapped
	r, _, err := lockProc.Call(file.Fd(), 3, 0, 1, 0, uintptr(unsafe.Pointer(&overlapped)))
	if r == 0 {
		return err
	}
	return nil
}
func unlockFile(file *os.File) {
	var overlapped syscall.Overlapped
	unlockProc.Call(file.Fd(), 0, 1, 0, uintptr(unsafe.Pointer(&overlapped)))
}
