package config

import (
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
)

type Config struct {
	Bind       string
	Port       int
	AllowCIDRs []string
	BasePath   string
}

func Parse(args []string) (Config, error) {
	cfg := Config{
		Bind:       "127.0.0.1",
		Port:       3275,
		AllowCIDRs: []string{},
	}

	for i := 0; i < len(args); i++ {
		arg := args[i]
		next := ""
		if i+1 < len(args) {
			next = args[i+1]
		}

		switch {
		case arg == "--bind" && next != "":
			cfg.Bind = next
			i++
		case strings.HasPrefix(arg, "--bind="):
			cfg.Bind = strings.TrimPrefix(arg, "--bind=")
		case arg == "--port" && next != "":
			v, err := strconv.Atoi(next)
			if err != nil {
				return Config{}, errors.New("port must be an integer")
			}
			cfg.Port = v
			i++
		case strings.HasPrefix(arg, "--port="):
			v, err := strconv.Atoi(strings.TrimPrefix(arg, "--port="))
			if err != nil {
				return Config{}, errors.New("port must be an integer")
			}
			cfg.Port = v
		case arg == "--allow-cidr" && next != "":
			cfg.AllowCIDRs = append(cfg.AllowCIDRs, next)
			i++
		case strings.HasPrefix(arg, "--allow-cidr="):
			cfg.AllowCIDRs = append(cfg.AllowCIDRs, strings.TrimPrefix(arg, "--allow-cidr="))
		case arg == "--base-path" && next != "":
			cfg.BasePath = next
			i++
		case strings.HasPrefix(arg, "--base-path="):
			cfg.BasePath = strings.TrimPrefix(arg, "--base-path=")
		}
	}

	if cfg.Port < 1 || cfg.Port > 65535 {
		return Config{}, errors.New("port must be between 1 and 65535")
	}

	for _, cidr := range cfg.AllowCIDRs {
		if _, _, err := net.ParseCIDR(cidr); err != nil {
			return Config{}, fmt.Errorf("invalid CIDR: %s", cidr)
		}
	}

	return cfg, nil
}

func IsAllowedClient(ip net.IP, allowCIDRs []string) bool {
	if ip == nil {
		return true
	}
	if ip.IsLoopback() {
		return true
	}
	if strings.HasPrefix(ip.String(), "fd7a:115c:a1e0:") {
		return true
	}
	if len(allowCIDRs) == 0 {
		return true
	}
	for _, cidr := range allowCIDRs {
		_, network, err := net.ParseCIDR(cidr)
		if err != nil {
			continue
		}
		if network.Contains(ip) {
			return true
		}
	}
	return false
}
