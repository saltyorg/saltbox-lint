package cmd

import "golang.org/x/sys/unix"

const terminalGetState = unix.TCGETS
const terminalSetState = unix.TCSETS
