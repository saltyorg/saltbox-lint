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
		command := exec.Command(os.Args[0], "child", filename)
		command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		if err := command.Start(); err != nil {
			os.Exit(2)
		}
		// Waiting is explicitly gated so the observer sees a real zombie.
		_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
		if err := command.Wait(); err != nil {
			os.Exit(2)
		}
		return
	}
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
