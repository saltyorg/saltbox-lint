package importer

import (
	"bytes"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"strconv"
)

// Grammar converts the complete plist tree, retaining unknown metadata and every
// regex byte after XML entity decoding. Manifest injections are registry data.
func Grammar(data []byte, injectTo []string) ([]byte, error) {
	var root map[string]any
	if json.Valid(data) {
		if err := json.Unmarshal(data, &root); err != nil {
			return nil, err
		}
	} else {
		d := xml.NewDecoder(bytes.NewReader(data))
		for {
			tok, err := d.Token()
			if err != nil {
				return nil, err
			}
			if s, ok := tok.(xml.StartElement); ok && s.Name.Local == "dict" {
				v, err := element(d, s)
				if err != nil {
					return nil, err
				}
				root = v.(map[string]any)
				break
			}
		}
	}
	if len(injectTo) > 0 {
		root["injectTo"] = injectTo
	}
	return json.MarshalIndent(root, "", "  ")
}

func element(d *xml.Decoder, start xml.StartElement) (any, error) {
	switch start.Name.Local {
	case "dict":
		result := map[string]any{}
		key := ""
		expectingKey := true
		for {
			tok, err := d.Token()
			if err != nil {
				return nil, err
			}
			switch s := tok.(type) {
			case xml.EndElement:
				if !expectingKey {
					return nil, fmt.Errorf("plist: missing value for %q", key)
				}
				return result, nil
			case xml.StartElement:
				if expectingKey && s.Name.Local != "key" {
					return nil, fmt.Errorf("plist: expected key")
				}
				v, err := element(d, s)
				if err != nil {
					return nil, err
				}
				if expectingKey {
					key = v.(string)
				} else {
					result[key] = v
				}
				expectingKey = !expectingKey
			}
		}
	case "array":
		result := []any{}
		for {
			tok, err := d.Token()
			if err != nil {
				return nil, err
			}
			switch s := tok.(type) {
			case xml.EndElement:
				return result, nil
			case xml.StartElement:
				v, err := element(d, s)
				if err != nil {
					return nil, err
				}
				result = append(result, v)
			}
		}
	case "string", "key", "integer", "real", "true", "false":
		var value string
		if err := d.DecodeElement(&value, &start); err != nil {
			return nil, err
		}
		switch start.Name.Local {
		case "integer":
			return strconv.ParseInt(value, 10, 64)
		case "real":
			return strconv.ParseFloat(value, 64)
		case "true":
			return true, nil
		case "false":
			return false, nil
		default:
			return value, nil
		}
	default:
		return nil, fmt.Errorf("unsupported plist element %q", start.Name.Local)
	}
}
