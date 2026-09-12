package main

import (
	"fmt"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

func setupEditorProcess() error {
	if os.Getenv("SALTBOX_LINT_EDITOR_PROCESS") != "1" {
		return nil
	}
	_, err := createEditorJob(windows.CurrentProcess())
	return err
}

// The noninheritable handle deliberately remains open for the entire process
// lifetime. Closing it in a defer would terminate this process too. The OS closes
// it on normal exit or forced termination, killing all remaining descendants.
func createEditorJob(process windows.Handle) (windows.Handle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, fmt.Errorf("create editor process job: %w", err)
	}
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		_ = windows.CloseHandle(job)
		return 0, fmt.Errorf("configure editor process job: %w", err)
	}
	if err := windows.AssignProcessToJobObject(job, process); err != nil {
		_ = windows.CloseHandle(job)
		return 0, fmt.Errorf("assign editor process job: %w", err)
	}
	return job, nil
}
