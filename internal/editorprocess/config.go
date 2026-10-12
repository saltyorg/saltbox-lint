// Package editorprocess connects an editor CLI group to its external test owner.
// Ordinary invocations do not enable this optional supervision protocol.
package editorprocess

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strconv"
	"time"
)

const (
	supervisorEnvironment = "SALTBOX_LINT_EDITOR_SUPERVISOR"
	editorEnvironment     = "SALTBOX_LINT_EDITOR_PROCESS"
	maximumLineBytes      = 2048
	handshakeTimeout      = 5 * time.Second
)

type configuration struct {
	Address string `json:"address"`
	Token   string `json:"token"`
	Nonce   string `json:"nonce"`
}

func parseConfiguration(value string) (configuration, error) {
	var config configuration
	if len(value) > maximumLineBytes || decodeMessage([]byte(value), &config) != nil {
		return configuration{}, errors.New("editor supervisor configuration is invalid")
	}
	host, port, err := net.SplitHostPort(config.Address)
	if err != nil || host != "127.0.0.1" {
		return configuration{}, errors.New("editor supervisor must use IPv4 loopback")
	}
	number, err := strconv.Atoi(port)
	if err != nil || number < 1 || number > 65535 || strconv.Itoa(number) != port {
		return configuration{}, errors.New("editor supervisor port is invalid")
	}
	token, err := hex.DecodeString(config.Token)
	if err != nil || len(token) != 32 || hex.EncodeToString(token) != config.Token {
		return configuration{}, errors.New("editor supervisor credential is invalid")
	}
	nonce, err := hex.DecodeString(config.Nonce)
	if err != nil || len(nonce) != 32 || hex.EncodeToString(nonce) != config.Nonce {
		return configuration{}, errors.New("editor supervisor reservation is invalid")
	}
	return config, nil
}

func decodeMessage(data []byte, value any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return errors.New("editor supervisor message contains trailing data")
	}
	return nil
}
