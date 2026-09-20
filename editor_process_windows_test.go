package main

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestEditorJobRejectsInvalidProcess(t *testing.T) {
	if _, err := createEditorJob(windows.Handle(0)); err == nil {
		t.Fatal("invalid process was accepted")
	}
}

func TestEditorJobKillsDescendants(t *testing.T) {
	if mode := os.Getenv("SALTBOX_JOB_TEST"); mode != "" {
		if mode == "descendant" {
			time.Sleep(time.Minute)
			os.Exit(0)
		}
		if err := setupEditorProcess(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		child := exec.Command(os.Args[0], "-test.run=^TestEditorJobKillsDescendants$")
		child.Env = append(os.Environ(), "SALTBOX_JOB_TEST=descendant")
		if err := child.Start(); err != nil {
			os.Exit(3)
		}
		fmt.Println(child.Process.Pid)
		if mode == "exit" {
			os.Exit(0)
		}
		time.Sleep(time.Minute)
		os.Exit(0)
	}
	for _, mode := range []string{"exit", "kill"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			parent := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestEditorJobKillsDescendants$")
			parent.Env = append(os.Environ(), "SALTBOX_LINT_EDITOR_PROCESS=1", "SALTBOX_JOB_TEST="+mode)
			parent.Stderr = os.Stderr
			pipe, err := parent.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			if err := parent.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = parent.Process.Kill() })
			scanner := bufio.NewScanner(pipe)
			if !scanner.Scan() {
				t.Fatal("missing descendant PID")
			}
			pid, err := strconv.Atoi(scanner.Text())
			if err != nil {
				t.Fatal(err)
			}
			handle, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_TERMINATE, false, uint32(pid))
			if err != nil {
				// The normal-exit child may already be gone before OpenProcess.
				if mode == "exit" && err == windows.ERROR_INVALID_PARAMETER {
					_ = parent.Wait()
					return
				}
				t.Fatal(err)
			}
			defer func() {
				_ = windows.TerminateProcess(handle, 1)
				_ = windows.CloseHandle(handle)
			}()
			if mode == "kill" {
				if err := parent.Process.Kill(); err != nil {
					t.Fatal(err)
				}
			}
			_ = parent.Wait()
			status, err := windows.WaitForSingleObject(handle, 10000)
			if err != nil || status != windows.WAIT_OBJECT_0 {
				t.Fatalf("descendant survived: status=%d err=%v", status, err)
			}
		})
	}
}
