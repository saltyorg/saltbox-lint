//go:build linux || darwin

// Test-only supervisor deliberately retains its child's exited process record.
package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"os"
	"os/exec"
	"syscall"
	"time"
)

func main() {
	filename := os.Args[2]
	if os.Args[1] == "parent" {
		parentRead, parentWrite, err := os.Pipe()
		if err != nil {
			os.Exit(2)
		}
		command := exec.Command(os.Args[0], "child", filename)
		command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		// Only the child inherits the read end. This parent alone holds the
		// writer, so parent death or its owner's EOF stops the actual child.
		command.ExtraFiles = []*os.File{parentRead}
		if err := command.Start(); err != nil {
			_ = parentRead.Close()
			_ = parentWrite.Close()
			os.Exit(2)
		}
		_ = parentRead.Close()
		// Waiting is explicitly gated so the observer sees a real zombie.
		_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
		_ = parentWrite.Close()
		if err := command.Wait(); err != nil {
			os.Exit(2)
		}
		return
	}
	if syscall.Getpgrp() != os.Getpid() {
		os.Exit(2)
	}
	parentLifetime := os.NewFile(3, "parent-lifetime")
	go func() {
		_, _ = io.Copy(io.Discard, parentLifetime)
		// This live child stops its current group; the parent never recovers
		// ownership by signaling a PID found in the fixture record.
		if err := syscall.Kill(0, syscall.SIGKILL); err != nil {
			os.Exit(2)
		}
		// Accepted SIGKILL is delivered by the kernel. Do not race it with a
		// different process exit while the parent observes native termination.
		select {}
	}()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		os.Exit(2)
	}
	var nonce [32]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		os.Exit(2)
	}
	token := hex.EncodeToString(nonce[:])
	instance := struct {
		PID   int    `json:"pid"`
		Port  int    `json:"port"`
		Token string `json:"token"`
	}{os.Getpid(), listener.Addr().(*net.TCPAddr).Port, token}
	data, err := json.Marshal(instance)
	if err != nil || os.WriteFile(filename+".tmp", data, 0o600) != nil || os.Rename(filename+".tmp", filename) != nil {
		os.Exit(2)
	}
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			_ = connection.SetWriteDeadline(time.Now().Add(time.Second))
			_, _ = io.WriteString(connection, token+"\n")
			_ = connection.Close()
		}
	}()
	for {
		if _, err := os.Stat(filename + ".exit"); err == nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
}
