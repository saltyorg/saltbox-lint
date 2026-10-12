//go:build !windows

package editorprocess

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"syscall"
	"time"
)

// StartFromEnvironment registers a POSIX group leader before it starts CLI work.
// The connection remains open until process exit. An authenticated owner stop or
// loss of that owner terminates this process's own group, including descendants.
// Descendants in an already-owned group do not acquire a second owner.
func StartFromEnvironment() error {
	value := os.Getenv(supervisorEnvironment)
	if os.Getenv(editorEnvironment) != "1" || value == "" {
		return nil
	}
	pid, group := os.Getpid(), syscall.Getpgrp()
	if pid <= 1 || group != pid {
		return nil
	}
	config, err := parseConfiguration(value)
	if err != nil {
		return err
	}
	connection, err := net.DialTimeout("tcp4", config.Address, handshakeTimeout)
	if err != nil {
		return fmt.Errorf("connect editor supervisor: %w", err)
	}
	admitted := false
	defer func() {
		if !admitted {
			_ = connection.Close()
		}
	}()
	if err := connection.SetDeadline(time.Now().Add(handshakeTimeout)); err != nil {
		return fmt.Errorf("set editor supervisor admission deadline: %w", err)
	}
	registration := struct {
		Token string `json:"token"`
		Type  string `json:"type"`
		Nonce string `json:"nonce"`
		PID   int    `json:"pid"`
		Group int    `json:"group"`
	}{config.Token, "bind", config.Nonce, pid, group}
	if err := json.NewEncoder(connection).Encode(registration); err != nil {
		return fmt.Errorf("register editor process group: %w", err)
	}
	reader := bufio.NewReaderSize(connection, maximumLineBytes)
	line, err := reader.ReadSlice('\n')
	if err != nil {
		return fmt.Errorf("read editor supervisor admission: %w", err)
	}
	var acknowledgement struct {
		Accepted bool `json:"accepted"`
	}
	if decodeMessage(line, &acknowledgement) != nil || !acknowledgement.Accepted {
		return errors.New("editor supervisor rejected process group")
	}
	if err := connection.SetDeadline(time.Time{}); err != nil {
		return fmt.Errorf("clear editor supervisor admission deadline: %w", err)
	}
	admitted = true
	go func() {
		// One stop message is the entire control protocol. EOF, invalid data and
		// transport errors also stop work because ownership is no longer known.
		_, _ = reader.ReadSlice('\n')
		// Signal only the group this live process still leads. Never send a
		// signal to a numeric group ID obtained from a remote journal or PID.
		if os.Getpid() == pid && syscall.Getpgrp() == pid {
			if err := syscall.Kill(-pid, syscall.SIGKILL); err != nil {
				fmt.Fprintln(os.Stderr, "terminate supervised editor group failed")
			}
		}
		// A moved group or failed signal is an incomplete cleanup observation
		// for the external owner. Exit this process without signaling siblings.
		os.Exit(2)
	}()
	return nil
}
