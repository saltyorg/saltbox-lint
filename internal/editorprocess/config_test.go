package editorprocess

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestSupervisorConfiguration(t *testing.T) {
	credential := strings.Repeat("a", 64)
	reservation := strings.Repeat("b", 64)
	valid, err := json.Marshal(configuration{Address: "127.0.0.1:4321", Token: credential, Nonce: reservation})
	if err != nil {
		t.Fatal(err)
	}
	if config, err := parseConfiguration(string(valid)); err != nil || config.Address != "127.0.0.1:4321" || config.Token != credential || config.Nonce != reservation {
		t.Fatalf("parse valid configuration: %#v, %v", config, err)
	}
	for name, value := range map[string]string{
		"malformed":           "{",
		"trailing":            string(valid) + " {}",
		"unknown field":       `{"address":"127.0.0.1:4321","token":"` + credential + `","other":true}`,
		"nonloopback":         `{"address":"192.0.2.1:4321","token":"` + credential + `"}`,
		"hostname":            `{"address":"localhost:4321","token":"` + credential + `"}`,
		"zero port":           `{"address":"127.0.0.1:0","token":"` + credential + `"}`,
		"invalid port":        `{"address":"127.0.0.1:65536","token":"` + credential + `"}`,
		"short credential":    `{"address":"127.0.0.1:4321","token":"` + credential[:32] + `"}`,
		"upper credential":    `{"address":"127.0.0.1:4321","token":"` + strings.ToUpper(credential) + `"}`,
		"missing reservation": `{"address":"127.0.0.1:4321","token":"` + credential + `"}`,
		"short reservation":   `{"address":"127.0.0.1:4321","token":"` + credential + `","nonce":"` + reservation[:32] + `"}`,
		"upper reservation":   `{"address":"127.0.0.1:4321","token":"` + credential + `","nonce":"` + strings.ToUpper(reservation) + `"}`,
		"oversized":           strings.Repeat(" ", maximumLineBytes) + string(valid),
	} {
		t.Run(name, func(t *testing.T) {
			_, err := parseConfiguration(value)
			if err == nil {
				t.Fatal("invalid configuration admitted")
			}
			if strings.Contains(err.Error(), credential[:32]) || strings.Contains(err.Error(), reservation[:32]) {
				t.Fatal("error exposes supervisor credential")
			}
		})
	}
}
