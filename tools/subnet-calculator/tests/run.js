"use strict";

const assert = require("node:assert");
const sc = require("../tool.js");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok - " + name);
  } catch (err) {
    failed++;
    console.error("  FAIL - " + name);
    console.error("         " + (err && err.message));
  }
}

console.log("subnet-calculator tests");

// ---------------------------------------------------------------------------
// Octet parsing
// ---------------------------------------------------------------------------

test("parses a dotted-quad to an unsigned integer", () => {
  assert.strictEqual(sc.parseOctets("0.0.0.0"), 0);
  assert.strictEqual(sc.parseOctets("255.255.255.255"), 4294967295);
  assert.strictEqual(sc.parseOctets("192.168.1.1"), 3232235777);
});

test("parses octets with surrounding whitespace", () => {
  assert.strictEqual(sc.parseOctets("  10.0.0.1  "), 167772161);
});

test("rejects octets above 255", () => {
  assert.strictEqual(sc.parseOctets("10.0.0.256"), null);
  assert.strictEqual(sc.parseOctets("999.1.1.1"), null);
});

test("rejects the wrong number of octets", () => {
  assert.strictEqual(sc.parseOctets("10.0.0"), null);
  assert.strictEqual(sc.parseOctets("10.0.0.1.2"), null);
});

test("rejects leading-zero octets", () => {
  assert.strictEqual(sc.parseOctets("010.0.0.1"), null);
  assert.strictEqual(sc.parseOctets("10.00.0.1"), null);
});

test("rejects non-numeric and signed octets", () => {
  assert.strictEqual(sc.parseOctets("a.b.c.d"), null);
  assert.strictEqual(sc.parseOctets("-1.0.0.1"), null);
  assert.strictEqual(sc.parseOctets("1e2.0.0.1"), null);
  assert.strictEqual(sc.parseOctets(""), null);
  assert.strictEqual(sc.parseOctets(null), null);
});

test("round-trips through toDotted", () => {
  ["0.0.0.0", "10.20.30.40", "172.16.255.254", "192.168.0.1", "255.255.255.255"].forEach((addr) => {
    assert.strictEqual(sc.toDotted(sc.parseOctets(addr)), addr);
  });
});

// ---------------------------------------------------------------------------
// Prefix and mask handling
// ---------------------------------------------------------------------------

test("parses valid prefixes", () => {
  assert.strictEqual(sc.parsePrefix("0"), 0);
  assert.strictEqual(sc.parsePrefix("24"), 24);
  assert.strictEqual(sc.parsePrefix(32), 32);
  assert.strictEqual(sc.parsePrefix(" 8 "), 8);
});

test("rejects invalid prefixes", () => {
  assert.strictEqual(sc.parsePrefix("33"), null);
  assert.strictEqual(sc.parsePrefix("-1"), null);
  assert.strictEqual(sc.parsePrefix("24.5"), null);
  assert.strictEqual(sc.parsePrefix("abc"), null);
  assert.strictEqual(sc.parsePrefix(""), null);
});

test("converts prefix lengths to netmasks", () => {
  assert.strictEqual(sc.toDotted(sc.prefixToMask(0)), "0.0.0.0");
  assert.strictEqual(sc.toDotted(sc.prefixToMask(8)), "255.0.0.0");
  assert.strictEqual(sc.toDotted(sc.prefixToMask(24)), "255.255.255.0");
  assert.strictEqual(sc.toDotted(sc.prefixToMask(26)), "255.255.255.192");
  assert.strictEqual(sc.toDotted(sc.prefixToMask(32)), "255.255.255.255");
});

test("converts netmasks back to prefix lengths", () => {
  assert.strictEqual(sc.maskToPrefix(sc.parseOctets("255.255.255.0")), 24);
  assert.strictEqual(sc.maskToPrefix(sc.parseOctets("255.255.255.192")), 26);
  assert.strictEqual(sc.maskToPrefix(sc.parseOctets("0.0.0.0")), 0);
});

test("rejects non-contiguous netmasks", () => {
  assert.strictEqual(sc.maskToPrefix(sc.parseOctets("255.0.255.0")), null);
  assert.strictEqual(sc.maskToPrefix(sc.parseOctets("255.255.255.1")), null);
});

// ---------------------------------------------------------------------------
// CIDR parsing
// ---------------------------------------------------------------------------

test("parses address with slash prefix", () => {
  const out = sc.parseCidr("192.168.1.10/24");
  assert.strictEqual(out.ok, true);
  assert.strictEqual(sc.toDotted(out.address), "192.168.1.10");
  assert.strictEqual(out.prefix, 24);
});

test("defaults a bare address to /32", () => {
  const out = sc.parseCidr("10.0.0.1");
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.prefix, 32);
});

test("accepts a dotted netmask as the prefix", () => {
  const out = sc.parseCidr("10.0.0.1/255.255.255.128");
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.prefix, 25);
});

test("reports empty input", () => {
  const out = sc.parseCidr("   ");
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /Enter an IPv4 address/);
});

test("explains IPv6 input instead of a generic error", () => {
  const out = sc.parseCidr("2001:db8::1/64");
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /IPv6/);
});

test("rejects an out-of-range prefix", () => {
  const out = sc.parseCidr("10.0.0.1/33");
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /between 0 and 32/);
});

test("rejects a non-contiguous dotted mask", () => {
  const out = sc.parseCidr("10.0.0.1/255.0.255.0");
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /contiguous/);
});

// ---------------------------------------------------------------------------
// Block arithmetic
// ---------------------------------------------------------------------------

test("computes network and broadcast", () => {
  const net = sc.parseOctets("192.168.10.130");
  assert.strictEqual(sc.toDotted(sc.networkAddress(net, 26)), "192.168.10.128");
  assert.strictEqual(sc.toDotted(sc.broadcastAddress(net, 26)), "192.168.10.191");
});

test("computes network and broadcast for /24", () => {
  const net = sc.parseOctets("10.1.2.3");
  assert.strictEqual(sc.toDotted(sc.networkAddress(net, 24)), "10.1.2.0");
  assert.strictEqual(sc.toDotted(sc.broadcastAddress(net, 24)), "10.1.2.255");
});

test("network of a /0 spans the entire space", () => {
  assert.strictEqual(sc.toDotted(sc.networkAddress(sc.parseOctets("8.8.8.8"), 0)), "0.0.0.0");
  assert.strictEqual(sc.toDotted(sc.broadcastAddress(sc.parseOctets("8.8.8.8"), 0)), "255.255.255.255");
});

test("broadcast of a /32 is the address itself", () => {
  assert.strictEqual(sc.toDotted(sc.broadcastAddress(sc.parseOctets("10.0.0.1"), 32)), "10.0.0.1");
});

test("counts total and usable addresses", () => {
  assert.strictEqual(sc.totalAddresses(24), 256);
  assert.strictEqual(sc.usableAddresses(24), 254);
  assert.strictEqual(sc.usableAddresses(30), 2);
  assert.strictEqual(sc.usableAddresses(31), 2);
  assert.strictEqual(sc.usableAddresses(32), 1);
  assert.strictEqual(sc.totalAddresses(0), 4294967296);
});

test("computes the usable host range", () => {
  const range = sc.hostRange(sc.parseOctets("192.168.10.130"), 26);
  assert.strictEqual(sc.toDotted(range.first), "192.168.10.129");
  assert.strictEqual(sc.toDotted(range.last), "192.168.10.190");
});

test("/31 and /32 have no conventional host range", () => {
  assert.strictEqual(sc.hostRange(sc.parseOctets("10.0.0.0"), 31), null);
  assert.strictEqual(sc.hostRange(sc.parseOctets("10.0.0.1"), 32), null);
});

test("handles the top of the address space without wrapping", () => {
  const net = sc.parseOctets("255.255.255.255");
  assert.strictEqual(sc.toDotted(sc.networkAddress(net, 24)), "255.255.255.0");
  assert.strictEqual(sc.toDotted(sc.broadcastAddress(net, 24)), "255.255.255.255");
});

// ---------------------------------------------------------------------------
// Address roles and classification
// ---------------------------------------------------------------------------

test("identifies network, broadcast and host roles", () => {
  assert.strictEqual(sc.addressRole(sc.parseOctets("10.0.0.0"), 24), "network");
  assert.strictEqual(sc.addressRole(sc.parseOctets("10.0.0.255"), 24), "broadcast");
  assert.strictEqual(sc.addressRole(sc.parseOctets("10.0.0.5"), 24), "host");
});

test("every address in a /31 or /32 is a host", () => {
  assert.strictEqual(sc.addressRole(sc.parseOctets("10.0.0.0"), 31), "host");
  assert.strictEqual(sc.addressRole(sc.parseOctets("10.0.0.1"), 32), "host");
});

test("classifies private ranges", () => {
  ["10.0.0.1", "10.255.255.254", "172.16.0.1", "172.31.255.255", "192.168.1.1"].forEach((addr) => {
    assert.strictEqual(sc.isPrivate(sc.parseOctets(addr)), true, addr + " should be private");
  });
});

test("does not classify public addresses as private", () => {
  ["8.8.8.8", "1.1.1.1", "172.32.0.1", "192.169.0.1"].forEach((addr) => {
    assert.strictEqual(sc.isPrivate(sc.parseOctets(addr)), false, addr + " should not be private");
  });
});

test("classifies loopback, link-local, multicast and documentation", () => {
  assert.strictEqual(sc.classify(sc.parseOctets("127.0.0.1")), "Loopback");
  assert.strictEqual(sc.classify(sc.parseOctets("169.254.10.1")), "Link-local (APIPA)");
  assert.strictEqual(sc.classify(sc.parseOctets("224.0.0.1")), "Multicast");
  assert.strictEqual(sc.classify(sc.parseOctets("203.0.113.7")), "Documentation");
  assert.strictEqual(sc.classify(sc.parseOctets("100.64.0.1")), "Shared address space (CGNAT)");
  assert.strictEqual(sc.classify(sc.parseOctets("8.8.4.4")), "Public");
});

test("treats 0.0.0.0/8 as the 'this network' block", () => {
  assert.strictEqual(sc.classify(sc.parseOctets("0.1.2.3")), "This network");
});

test("reports the legacy classful class", () => {
  assert.strictEqual(sc.classfulLetter(sc.parseOctets("10.0.0.1")), "A");
  assert.strictEqual(sc.classfulLetter(sc.parseOctets("172.16.0.1")), "B");
  assert.strictEqual(sc.classfulLetter(sc.parseOctets("192.168.1.1")), "C");
  assert.match(sc.classfulLetter(sc.parseOctets("224.0.0.1")), /D/);
  assert.match(sc.classfulLetter(sc.parseOctets("250.0.0.1")), /E/);
});

// ---------------------------------------------------------------------------
// Reverse DNS
// ---------------------------------------------------------------------------

test("builds the full reverse-DNS name", () => {
  assert.strictEqual(
    sc.reverseDns(sc.parseOctets("192.168.1.10")),
    "10.1.168.192.in-addr.arpa"
  );
});

test("builds the delegated reverse zone for classful boundaries", () => {
  assert.strictEqual(sc.reverseZone(sc.parseOctets("192.168.1.10"), 24), "1.168.192.in-addr.arpa");
  assert.strictEqual(sc.reverseZone(sc.parseOctets("10.20.5.1"), 16), "20.10.in-addr.arpa");
  assert.strictEqual(sc.reverseZone(sc.parseOctets("10.0.0.1"), 8), "10.in-addr.arpa");
});

test("reverse zone includes the octet when the prefix is not a /24 boundary", () => {
  assert.strictEqual(sc.reverseZone(sc.parseOctets("192.168.1.64"), 26), "64.1.168.192.in-addr.arpa");
});

test("reverse zone for /0 is the root zone", () => {
  assert.strictEqual(sc.reverseZone(sc.parseOctets("8.8.8.8"), 0), "in-addr.arpa");
});

// ---------------------------------------------------------------------------
// Full calculation
// ---------------------------------------------------------------------------

test("calculate returns the expected block details", () => {
  const r = sc.calculate(sc.parseOctets("192.168.10.130"), 26);
  assert.strictEqual(r.network, "192.168.10.128");
  assert.strictEqual(r.broadcast, "192.168.10.191");
  assert.strictEqual(r.netmask, "255.255.255.192");
  assert.strictEqual(r.wildcard, "0.0.0.63");
  assert.strictEqual(r.firstHost, "192.168.10.129");
  assert.strictEqual(r.lastHost, "192.168.10.190");
  assert.strictEqual(r.total, 64);
  assert.strictEqual(r.usable, 62);
  assert.strictEqual(r.isPrivate, true);
  assert.strictEqual(r.role, "host");
});

test("calculate marks a network address correctly", () => {
  const r = sc.calculate(sc.parseOctets("10.20.0.0"), 16);
  assert.strictEqual(r.role, "network");
  assert.strictEqual(r.addressClass, "A");
  assert.strictEqual(r.classification, "Private (RFC 1918)");
});

test("calculate reports 'not defined' range for /32", () => {
  const r = sc.calculate(sc.parseOctets("203.0.113.5"), 32);
  assert.strictEqual(r.firstHost, null);
  assert.strictEqual(r.lastHost, null);
  assert.strictEqual(r.usable, 1);
  assert.strictEqual(r.role, "host");
});

test("describeBlock matches calculate for the same network", () => {
  const described = sc.describeBlock(sc.parseOctets("10.1.2.3"), 24);
  const calc = sc.calculate(sc.parseOctets("10.1.2.3"), 24);
  assert.strictEqual(described.network, calc.network);
  assert.strictEqual(described.broadcast, calc.broadcast);
  assert.strictEqual(described.cidr, "10.1.2.0/24");
});

// ---------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------

test("picks the smallest prefix for a host count", () => {
  assert.strictEqual(sc.prefixForHosts(0), 32);
  assert.strictEqual(sc.prefixForHosts(1), 32);
  assert.strictEqual(sc.prefixForHosts(2), 31);
  assert.strictEqual(sc.prefixForHosts(3), 29);
  assert.strictEqual(sc.prefixForHosts(50), 26);
  assert.strictEqual(sc.prefixForHosts(254), 24);
  assert.strictEqual(sc.prefixForHosts(255), 23);
  assert.strictEqual(sc.prefixForHosts(-1), null);
});

test("splits a block into two children", () => {
  const out = sc.splitBlock(sc.parseOctets("10.0.0.0"), 24);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.children.length, 2);
  assert.strictEqual(out.children[0].cidr, "10.0.0.0/25");
  assert.strictEqual(out.children[1].cidr, "10.0.0.128/25");
});

test("refuses to split a /32", () => {
  const out = sc.splitBlock(sc.parseOctets("10.0.0.1"), 32);
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /cannot be split/);
});

test("splits a /24 into four /26s", () => {
  const out = sc.splitInto(sc.parseOctets("10.0.0.0"), 24, 26);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.count, 4);
  assert.deepStrictEqual(out.subnets.map((s) => s.cidr), [
    "10.0.0.0/26",
    "10.0.0.64/26",
    "10.0.0.128/26",
    "10.0.0.192/26"
  ]);
});

test("split subnets tile the parent exactly", () => {
  const out = sc.splitInto(sc.parseOctets("192.168.0.0"), 22, 26);
  assert.strictEqual(out.count, 16);
  // Each subnet starts where the previous one ended, and the last ends at the
  // parent's broadcast.
  for (let i = 1; i < out.subnets.length; i++) {
    const prevEnd = sc.parseOctets(out.subnets[i - 1].broadcast);
    const curStart = sc.parseOctets(out.subnets[i].network);
    assert.strictEqual(curStart, prevEnd + 1, "subnet " + i + " is not contiguous");
  }
  assert.strictEqual(out.subnets[out.subnets.length - 1].broadcast, "192.168.3.255");
});

test("split normalizes from an address inside the block", () => {
  const out = sc.splitInto(sc.parseOctets("10.0.0.200"), 24, 25);
  assert.strictEqual(out.subnets[0].cidr, "10.0.0.0/25");
});

test("rejects a target prefix shorter than the source", () => {
  const out = sc.splitInto(sc.parseOctets("10.0.0.0"), 24, 16);
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /between/);
});

test("caps runaway splits", () => {
  const out = sc.splitInto(sc.parseOctets("10.0.0.0"), 8, 32);
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /subnets/);
});

test("splits by hosts-per-subnet", () => {
  const out = sc.splitByHosts(sc.parseOctets("10.0.0.0"), 24, 50);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.newPrefix, 26);
  assert.strictEqual(out.count, 4);
  assert.strictEqual(out.usable, 62);
});

test("rejects an impossible host requirement", () => {
  const out = sc.splitByHosts(sc.parseOctets("10.0.0.0"), 28, 100);
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /cannot fit/);
  const zero = sc.splitByHosts(sc.parseOctets("10.0.0.0"), 24, 0);
  assert.strictEqual(zero.ok, false);
});

// ---------------------------------------------------------------------------
// Range covering
// ---------------------------------------------------------------------------

test("covers an aligned range with a single block", () => {
  const out = sc.coverRange(sc.parseOctets("10.0.0.0"), sc.parseOctets("10.0.0.3"));
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].prefix, 30);
});

test("covers an unaligned range with multiple blocks", () => {
  const out = sc.coverRange(sc.parseOctets("10.0.0.1"), sc.parseOctets("10.0.0.6"));
  const cidrs = out.map((b) => sc.toDotted(b.address) + "/" + b.prefix);
  assert.deepStrictEqual(cidrs, ["10.0.0.1/32", "10.0.0.2/31", "10.0.0.4/31", "10.0.0.6/32"]);
});

test("range cover never exceeds the requested span", () => {
  const start = sc.parseOctets("192.168.5.10");
  const end = sc.parseOctets("192.168.6.200");
  const out = sc.coverRange(start, end);
  const first = sc.networkAddress(out[0].address, out[0].prefix);
  const last = sc.broadcastAddress(out[out.length - 1].address, out[out.length - 1].prefix);
  assert.strictEqual(first, start);
  assert.strictEqual(last, end);
});

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

test("merges two adjacent halves into a whole", () => {
  const out = sc.mergeList("10.0.0.0/25 10.0.0.128/25");
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.merged.map((b) => b.cidr), ["10.0.0.0/24"]);
});

test("merges an overlap into its supernet", () => {
  const out = sc.mergeList("10.0.0.0/16\n10.0.5.0/24");
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.merged.map((b) => b.cidr), ["10.0.0.0/16"]);
});

test("leaves non-adjacent blocks separate", () => {
  const out = sc.mergeList("192.168.1.0/24, 192.168.3.0/24");
  assert.deepStrictEqual(out.merged.map((b) => b.cidr), ["192.168.1.0/24", "192.168.3.0/24"]);
});

test("merges four quarters into a /24", () => {
  const out = sc.mergeList(["10.0.0.0/26", "10.0.0.64/26", "10.0.0.128/26", "10.0.0.192/26"].join("\n"));
  assert.deepStrictEqual(out.merged.map((b) => b.cidr), ["10.0.0.0/24"]);
});

test("merge sorts its input", () => {
  const out = sc.mergeList("10.0.0.128/25\n10.0.0.0/25");
  assert.deepStrictEqual(out.merged.map((b) => b.cidr), ["10.0.0.0/24"]);
});

test("merge reports empty input", () => {
  const out = sc.mergeList("   ");
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /at least one/);
});

test("merge surfaces the offending token", () => {
  const out = sc.mergeList("10.0.0.0/24 not-an-address");
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /not-an-address/);
});

test("merge output blocks are their own network addresses", () => {
  const out = sc.mergeList("10.0.0.5/24");
  assert.strictEqual(out.merged[0].cidr, "10.0.0.0/24");
});

// ---------------------------------------------------------------------------
// Membership check
// ---------------------------------------------------------------------------

test("finds a match inside a block", () => {
  const out = sc.checkMembership("10.20.30.40", "10.20.0.0/16\n192.168.0.0/16");
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.matches.length, 1);
  assert.strictEqual(out.matches[0].cidr, "10.20.0.0/16");
});

test("reports the containing block among nested matches", () => {
  const out = sc.checkMembership("10.20.5.5", "10.0.0.0/8\n10.20.0.0/16\n10.20.5.0/24");
  assert.strictEqual(out.matches.length, 3);
  assert.deepStrictEqual(out.matches.map((m) => m.cidr), ["10.0.0.0/8", "10.20.0.0/16", "10.20.5.0/24"]);
});

test("reports no match", () => {
  const out = sc.checkMembership("8.8.8.8", "10.0.0.0/8, 192.168.0.0/16");
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.matches.length, 0);
});

test("check rejects an invalid address", () => {
  const out = sc.checkMembership("300.1.1.1", "10.0.0.0/8");
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /valid IPv4/);
});

test("check explains IPv6 input", () => {
  const out = sc.checkMembership("2001:db8::1", "10.0.0.0/8");
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /IPv6/);
});

test("check requires a list", () => {
  const out = sc.checkMembership("10.0.0.1", "");
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /at least one/);
});

test("membership is inclusive of the broadcast address", () => {
  const out = sc.checkMembership("10.0.0.255", "10.0.0.0/24");
  assert.strictEqual(out.matches.length, 1);
});

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

test("formats counts with thousands separators", () => {
  assert.strictEqual(sc.formatCount(4294967296), "4,294,967,296");
  assert.strictEqual(sc.formatCount(256), "256");
  assert.strictEqual(sc.formatCount(0), "0");
});

// ---------------------------------------------------------------------------
// Robustness / security-oriented cases
// ---------------------------------------------------------------------------

test("does not execute injected content", () => {
  // Values that would be dangerous if ever passed to innerHTML or eval.
  const payloads = [
    "<script>alert(1)</script>",
    "javascript:alert(1)",
    '"; DROP TABLE subnets; --',
    "10.0.0.1/24<script>"
  ];
  payloads.forEach((payload) => {
    const parsed = sc.parseCidr(payload);
    assert.strictEqual(parsed.ok, false, payload + " must not parse");
    const merged = sc.mergeList(payload);
    assert.strictEqual(merged.ok, false);
  });
});

test("handles a very large but legal input without throwing", () => {
  // A /8 split into /16s is the largest split the UI allows (4096 subnets).
  const out = sc.splitInto(sc.parseOctets("10.0.0.0"), 8, 20);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.count, 4096);
  assert.strictEqual(out.subnets[0].cidr, "10.0.0.0/20");
  assert.strictEqual(out.subnets[4095].cidr, "10.255.240.0/20");
});

test("merge collapses a large list deterministically", () => {
  const input = [];
  for (let i = 0; i < 256; i++) input.push("10.0." + i + ".0/24");
  const out = sc.mergeList(input.join("\n"));
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.merged.map((b) => b.cidr), ["10.0.0.0/16"]);
});

test("parsing is stable for repeated identical input", () => {
  const first = sc.calculate(sc.parseOctets("172.16.45.200"), 20);
  const second = sc.calculate(sc.parseOctets("172.16.45.200"), 20);
  assert.deepStrictEqual(first, second);
});

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
