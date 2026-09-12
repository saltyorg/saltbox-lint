package cmd

import "golang.org/x/sys/unix"

const terminalGetState = unix.TIOCGETA
const terminalSetState = unix.TIOCSETA
