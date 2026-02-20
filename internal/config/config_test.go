package config

import (
	"net"
	"testing"
)

func TestParseConfigFlags(t *testing.T) {
	cfg, err := Parse([]string{"--bind", "0.0.0.0", "--port", "4001", "--allow-cidr", "100.64.0.0/10"})
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	if cfg.Bind != "0.0.0.0" || cfg.Port != 4001 {
		t.Fatalf("unexpected cfg: %+v", cfg)
	}
	if len(cfg.AllowCIDRs) != 1 || cfg.AllowCIDRs[0] != "100.64.0.0/10" {
		t.Fatalf("unexpected cidrs: %+v", cfg.AllowCIDRs)
	}
}

func TestIsAllowedClient(t *testing.T) {
	if !IsAllowedClient(net.ParseIP("127.0.0.1"), nil) {
		t.Fatal("loopback should be allowed")
	}
	if IsAllowedClient(net.ParseIP("8.8.8.8"), []string{"10.0.0.0/8"}) {
		t.Fatal("8.8.8.8 should not be allowed")
	}
	if !IsAllowedClient(net.ParseIP("10.1.2.3"), []string{"10.0.0.0/8"}) {
		t.Fatal("10.1.2.3 should be allowed")
	}
}
