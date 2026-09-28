/* Toolshed — IPv4 Subnet Calculator
 * Core logic, dependency-free. Loads in the browser as
 * window.Toolshed.subnetCalculator and in Node via require() for tests.
 *
 * Everything is computed from the user's input in memory. The module never
 * touches the network, never uses eval/dynamic code execution, and never
 * writes to storage.
 *
 * IPv4 arithmetic is done with unsigned 32-bit integers. Addresses are held
 * as numbers internally (masked with >>> 0 so they stay unsigned) and only
 * converted to dotted-quad strings for display.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Toolshed = root.Toolshed || {};
    root.Toolshed.subnetCalculator = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var U32 = 0xFFFFFFFF;
  var MAX_PREFIX = 32;
  var MIN_PREFIX = 0;

  // Canonical descriptions of the special-purpose IPv4 blocks a network
  // engineer expects a calculator to answer for.
  var SPECIAL_RANGES = [
    { name: "Private (RFC 1918)", cidr: "10.0.0.0/8" },
    { name: "Private (RFC 1918)", cidr: "172.16.0.0/12" },
    { name: "Private (RFC 1918)", cidr: "192.168.0.0/16" },
    { name: "Loopback", cidr: "127.0.0.0/8" },
    { name: "Link-local (APIPA)", cidr: "169.254.0.0/16" },
    { name: "Shared address space (CGNAT)", cidr: "100.64.0.0/10" },
    { name: "Benchmarking", cidr: "198.18.0.0/15" },
    { name: "Documentation", cidr: "192.0.2.0/24" },
    { name: "Documentation", cidr: "198.51.100.0/24" },
    { name: "Documentation", cidr: "203.0.113.0/24" },
    { name: "6to4 relay anycast", cidr: "192.88.99.0/24" },
    { name: "Multicast", cidr: "224.0.0.0/4" },
    { name: "Reserved (future use)", cidr: "240.0.0.0/4" },
    { name: "Limited broadcast", cidr: "255.255.255.255/32" }
  ];

  // ---------------------------------------------------------------------
  // Primitive conversions
  // ---------------------------------------------------------------------

  /**
   * Convert a dotted-quad IPv4 string to an unsigned 32-bit number.
   * Rejects anything that is not exactly four decimal octets in 0–255,
   * including out-of-range values and leading-zero forms like "010".
   * @param {string} str
   * @returns {number|null} unsigned integer, or null when invalid
   */
  function parseOctets(str) {
    var s = String(str == null ? "" : str).trim();
    var parts = s.split(".");
    if (parts.length !== 4) return null;

    var value = 0;
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (!/^\d{1,3}$/.test(part)) return null;
      if (part.length > 1 && part.charAt(0) === "0") return null;
      var n = parseInt(part, 10);
      if (n > 255) return null;
      value = value * 256 + n;
    }
    return value >>> 0;
  }

  /**
   * Convert an unsigned 32-bit number back to dotted-quad.
   * @param {number} n
   * @returns {string}
   */
  function toDotted(n) {
    var v = n >>> 0;
    return (
      (v >>> 24) + "." +
      ((v >>> 16) & 255) + "." +
      ((v >>> 8) & 255) + "." +
      (v & 255)
    );
  }

  /**
   * Parse a prefix length. Accepts 0–32, rejects decimals and blanks.
   * @param {string|number} value
   * @returns {number|null}
   */
  function parsePrefix(value) {
    if (value === null || value === undefined) return null;
    var s = String(value).trim();
    if (!/^\d{1,2}$/.test(s)) return null;
    var n = parseInt(s, 10);
    if (n < MIN_PREFIX || n > MAX_PREFIX) return null;
    return n;
  }

  /**
   * Convert an unsigned netmask to a prefix length, or null if the mask has
   * one-bits after a zero-bit (i.e. is not a contiguous mask).
   * @param {number} mask
   * @returns {number|null}
   */
  function maskToPrefix(mask) {
    var m = mask >>> 0;
    var prefix = 0;
    var seenZero = false;
    for (var i = 31; i >= 0; i--) {
      var bit = (m >>> i) & 1;
      if (bit === 1) {
        if (seenZero) return null;
        prefix++;
      } else {
        seenZero = true;
      }
    }
    return prefix;
  }

  /**
   * Convert a prefix length to an unsigned 32-bit netmask.
   * @param {number} prefix
   * @returns {number}
   */
  function prefixToMask(prefix) {
    if (prefix <= 0) return 0;
    return (U32 << (32 - prefix)) >>> 0;
  }

  // ---------------------------------------------------------------------
  // Parsing
  // ---------------------------------------------------------------------

  /**
   * Parse "192.168.1.10/24" or "192.168.1.10/255.255.255.0".
   * A bare address defaults to /32.
   * @param {string} input
   * @returns {{ok:true,address:number,prefix:number}|{ok:false,error:string}}
   */
  function parseCidr(input) {
    var s = String(input == null ? "" : input).trim();
    if (s === "") {
      return { ok: false, error: "Enter an IPv4 address, optionally with a prefix (e.g. 192.168.1.10/24)." };
    }

    var slash = s.indexOf("/");
    var addressPart = slash === -1 ? s : s.slice(0, slash);
    var prefixPart = slash === -1 ? "32" : s.slice(slash + 1);

    var address = parseOctets(addressPart);
    if (address === null) {
      var hint = looksLikeIPv6(addressPart)
        ? "IPv6 addresses are not supported — enter an IPv4 address."
        : '"' + addressPart + '" is not a valid IPv4 address. Use four octets between 0 and 255.';
      return { ok: false, error: hint };
    }

    var prefix;
    if (prefixPart.indexOf(".") !== -1) {
      var mask = parseOctets(prefixPart);
      if (mask === null) {
        return { ok: false, error: '"' + prefixPart + '" is not a valid subnet mask.' };
      }
      prefix = maskToPrefix(mask);
      if (prefix === null) {
        return { ok: false, error: '"' + prefixPart + '" is not a valid subnet mask — its bits must be contiguous (e.g. 255.255.255.0).' };
      }
    } else {
      prefix = parsePrefix(prefixPart);
      if (prefix === null) {
        return { ok: false, error: 'Prefix "/' + prefixPart + '" must be a whole number between 0 and 32.' };
      }
    }

    return { ok: true, address: address, prefix: prefix };
  }

  /**
   * True if a string looks like an IPv6 literal, so the UI can explain why it
   * cannot be handled instead of showing a generic octet error.
   * @param {string} input
   * @returns {boolean}
   */
  function looksLikeIPv6(input) {
    return String(input == null ? "" : input).trim().indexOf(":") !== -1;
  }

  // ---------------------------------------------------------------------
  // Block arithmetic
  // ---------------------------------------------------------------------

  /**
   * The network (base) address for an address/prefix pair.
   * @param {number} address
   * @param {number} prefix
   * @returns {number}
   */
  function networkAddress(address, prefix) {
    return (address & prefixToMask(prefix)) >>> 0;
  }

  /**
   * The directed broadcast address for an address/prefix pair.
   * @param {number} address
   * @param {number} prefix
   * @returns {number}
   */
  function broadcastAddress(address, prefix) {
    var mask = prefixToMask(prefix);
    return ((address & mask) | (~mask >>> 0)) >>> 0;
  }

  /**
   * Total addresses in a block, network and broadcast included.
   * @param {number} prefix
   * @returns {number}
   */
  function totalAddresses(prefix) {
    return Math.pow(2, 32 - prefix);
  }

  /**
   * Usable host addresses. /31 is treated as an RFC 3021 point-to-point link
   * and /32 as a single host, matching how modern tooling presents them.
   * @param {number} prefix
   * @returns {number}
   */
  function usableAddresses(prefix) {
    if (prefix === 32) return 1;
    if (prefix === 31) return 2;
    return Math.pow(2, 32 - prefix) - 2;
  }

  /**
   * The usable host range, or null for /31 and /32 which have none in the
   * conventional sense.
   * @param {number} address
   * @param {number} prefix
   * @returns {{first:number,last:number}|null}
   */
  function hostRange(address, prefix) {
    if (prefix >= 31) return null;
    var net = networkAddress(address, prefix);
    return { first: (net + 1) >>> 0, last: (broadcastAddress(address, prefix) - 1) >>> 0 };
  }

  // ---------------------------------------------------------------------
  // Classification
  // ---------------------------------------------------------------------

  // Precomputed [name, network, broadcast] triples so classify() stays O(1)
  // per range without re-parsing on every call.
  var RANGE_BOUNDS = SPECIAL_RANGES.map(function (range) {
    var parsed = parseCidr(range.cidr);
    return {
      name: range.name,
      network: networkAddress(parsed.address, parsed.prefix),
      broadcast: broadcastAddress(parsed.address, parsed.prefix)
    };
  });
  var THIS_NETWORK = { name: "This network", network: parseOctets("0.0.0.0"), broadcast: parseOctets("0.255.255.255") };

  /**
   * Classify an address against the special-purpose registry.
   * @param {number} address
   * @returns {string} e.g. "Private (RFC 1918)", "Public", "Loopback"
   */
  function classify(address) {
    var a = address >>> 0;
    if (a >= THIS_NETWORK.network && a <= THIS_NETWORK.broadcast) return THIS_NETWORK.name;
    for (var i = 0; i < RANGE_BOUNDS.length; i++) {
      var r = RANGE_BOUNDS[i];
      if (a >= r.network && a <= r.broadcast) return r.name;
    }
    return "Public";
  }

  /**
   * True when the address falls inside any private (RFC 1918) block.
   * @param {number} address
   * @returns {boolean}
   */
  function isPrivate(address) {
    return classify(address) === "Private (RFC 1918)";
  }

  /**
   * True when the address is loopback.
   * @param {number} address
   * @returns {boolean}
   */
  function isLoopback(address) {
    return classify(address) === "Loopback";
  }

  /**
   * True when the address is multicast (224.0.0.0/4).
   * @param {number} address
   * @returns {boolean}
   */
  function isMulticast(address) {
    return classify(address) === "Multicast";
  }

  /**
   * Describe an address as "network", "broadcast" or "host" within its own
   * block. /31 and /32 blocks have no reserved addresses, so every address
   * there is a host.
   * @param {number} address
   * @param {number} prefix
   * @returns {string}
   */
  function addressRole(address, prefix) {
    if (prefix >= 31) return "host";
    if (address === networkAddress(address, prefix)) return "network";
    if (address === broadcastAddress(address, prefix)) return "broadcast";
    return "host";
  }

  /**
   * The legacy classful class letter for an address: A, B, C, D or E.
   * @param {number} address
   * @returns {string}
   */
  function classfulLetter(address) {
    var first = (address >>> 24) & 255;
    if (first < 128) return "A";
    if (first < 192) return "B";
    if (first < 224) return "C";
    if (first < 240) return "D (multicast)";
    return "E (reserved)";
  }

  // ---------------------------------------------------------------------
  // Reverse DNS
  // ---------------------------------------------------------------------

  /**
   * The full in-addr.arpa name for an address.
   * @param {number} address
   * @returns {string}
   */
  function reverseDns(address) {
    var v = address >>> 0;
    return (
      (v & 255) + "." +
      ((v >>> 8) & 255) + "." +
      ((v >>> 16) & 255) + "." +
      ((v >>> 24) & 255) + ".in-addr.arpa"
    );
  }

  /**
   * The reverse-DNS zone a block is delegated under. Zones live on octet
   * boundaries, so a /8, /16 or /24 maps to the matching reversed labels; any
   * other prefix (including /32) uses the full four-octet name of the network
   * address.
   * @param {number} address
   * @param {number} prefix
   * @returns {string}
   */
  function reverseZone(address, prefix) {
    if (prefix === 0) return "in-addr.arpa";
    if (prefix < 32 && prefix % 8 === 0) {
      var v = networkAddress(address, prefix) >>> 0;
      var labels = prefix / 8;
      var top = [];
      for (var i = 0; i < labels; i++) {
        top.push((v >>> (8 * (3 - i))) & 255);
      }
      return top.reverse().join(".") + ".in-addr.arpa";
    }
    return reverseDns(networkAddress(address, prefix));
  }

  // ---------------------------------------------------------------------
  // Block description
  // ---------------------------------------------------------------------

  /**
   * Build the full description of one block. This is the shape every view
   * (main result, split tree, table rows, merge output) consumes. Pure data,
   * no DOM.
   * @param {number} network
   * @param {number} prefix
   * @returns {object}
   */
  function describeBlock(network, prefix) {
    var net = networkAddress(network, prefix);
    var broadcast = broadcastAddress(net, prefix);
    var hosts = hostRange(net, prefix);
    return {
      address: net,
      cidr: toDotted(net) + "/" + prefix,
      network: toDotted(net),
      broadcast: toDotted(broadcast),
      netmask: toDotted(prefixToMask(prefix)),
      wildcard: toDotted((~prefixToMask(prefix)) >>> 0),
      prefix: prefix,
      total: totalAddresses(prefix),
      usable: usableAddresses(prefix),
      rangeStart: hosts ? toDotted(hosts.first) : null,
      rangeEnd: hosts ? toDotted(hosts.last) : null,
      firstHost: hosts ? toDotted(hosts.first) : null,
      lastHost: hosts ? toDotted(hosts.last) : null,
      isPrivate: isPrivate(net),
      classification: classify(net),
      role: addressRole(net, prefix)
    };
  }

  /**
   * The complete result for a parsed address/prefix. Includes both the block
   * it belongs to and details about the specific input address.
   * @param {number} address
   * @param {number} prefix
   * @returns {object}
   */
  function calculate(address, prefix) {
    var block = describeBlock(address, prefix);
    return {
      input: toDotted(address),
      inputCidr: toDotted(address) + "/" + prefix,
      prefix: prefix,
      network: block.network,
      broadcast: block.broadcast,
      netmask: block.netmask,
      wildcard: block.wildcard,
      firstHost: block.firstHost,
      lastHost: block.lastHost,
      rangeStart: block.rangeStart,
      rangeEnd: block.rangeEnd,
      total: block.total,
      usable: block.usable,
      isPrivate: block.isPrivate,
      classification: block.classification,
      role: addressRole(address, prefix),
      addressClass: classfulLetter(address),
      reverseDns: reverseDns(address),
      reverseZone: reverseZone(address, prefix)
    };
  }

  // ---------------------------------------------------------------------
  // Splitting
  // ---------------------------------------------------------------------

  /**
   * The smallest prefix whose block holds at least `hosts` usable addresses.
   * Returns /32 for 0 or 1 host.
   * @param {number} hosts
   * @returns {number|null}
   */
  function prefixForHosts(hosts) {
    var n = Number(hosts);
    if (!isFinite(n) || n < 0) return null;
    if (n <= 1) return 32;
    for (var p = 32; p >= 0; p--) {
      if (usableAddresses(p) >= n) return p;
    }
    return null;
  }

  /**
   * Split a block into its two child blocks (prefix + 1).
   * @param {number} network
   * @param {number} prefix
   * @returns {{ok:true,children:Array<object>}|{ok:false,error:string}}
   */
  function splitBlock(network, prefix) {
    if (prefix >= 32) {
      return { ok: false, error: "A /32 block cannot be split any further." };
    }
    var childPrefix = prefix + 1;
    var first = networkAddress(network, childPrefix);
    var second = (first + totalAddresses(childPrefix)) >>> 0;
    return { ok: true, children: [describeBlock(first, childPrefix), describeBlock(second, childPrefix)] };
  }

  /**
   * Split a block into a uniform set of subnets of `targetPrefix`.
   * @param {number} address
   * @param {number} prefix
   * @param {number} targetPrefix
   * @returns {{ok:true,newPrefix:number,count:number,usable:number,subnets:Array<object>}|{ok:false,error:string}}
   */
  function splitInto(address, prefix, targetPrefix) {
    var target = Number(targetPrefix);
    if (!isFinite(target) || target < prefix || target > 32) {
      return { ok: false, error: "The new prefix must be between /" + prefix + " and /32." };
    }
    var count = Math.pow(2, target - prefix);
    if (count > 4096) {
      return { ok: false, error: "That split would create " + formatCount(count) + " subnets. Choose a target prefix at most 12 bits longer than /" + prefix + "." };
    }
    var net = networkAddress(address, prefix);
    var size = totalAddresses(target);
    var subnets = [];
    for (var i = 0; i < count; i++) {
      subnets.push(describeBlock((net + i * size) >>> 0, target));
    }
    return { ok: true, newPrefix: target, count: count, usable: usableAddresses(target), subnets: subnets };
  }

  /**
   * Split a block into subnets that each hold at least `hosts` usable
   * addresses, using the smallest uniform new prefix that satisfies it.
   * @param {number} address
   * @param {number} prefix
   * @param {number} hosts
   * @returns {{ok:true,newPrefix:number,count:number,usable:number,subnets:Array<object>}|{ok:false,error:string}}
   */
  function splitByHosts(address, prefix, hosts) {
    var needed = Number(hosts);
    if (!isFinite(needed) || needed < 1) {
      return { ok: false, error: "Enter how many usable hosts each subnet needs." };
    }
    var newPrefix = prefixForHosts(needed);
    if (newPrefix === null || newPrefix < prefix) {
      return { ok: false, error: "A /" + prefix + " block cannot fit a subnet with " + formatCount(needed) + " usable hosts." };
    }
    return splitInto(address, prefix, newPrefix);
  }

  // ---------------------------------------------------------------------
  // List operations: merge / membership
  // ---------------------------------------------------------------------

  /**
   * Parse a whitespace/comma/newline separated list of CIDR strings.
   * @param {string} text
   * @returns {{ok:true,blocks:Array<object>}|{ok:false,error:string}}
   */
  function parseList(text) {
    var raw = String(text == null ? "" : text).split(/[\s,]+/);
    var blocks = [];
    for (var i = 0; i < raw.length; i++) {
      var token = raw[i].trim();
      if (token === "") continue;
      var parsed = parseCidr(token);
      if (!parsed.ok) return { ok: false, error: token + ": " + parsed.error };
      blocks.push(parsed);
    }
    return { ok: true, blocks: blocks };
  }

  /**
   * Sort blocks numerically, then by prefix.
   * @param {Array<{address:number,prefix:number}>} blocks
   * @returns {Array<{address:number,prefix:number}>}
   */
  function sortBlocks(blocks) {
    return blocks.slice().sort(function (a, b) {
      if (a.address !== b.address) return a.address - b.address;
      return a.prefix - b.prefix;
    });
  }

  /**
   * Represent an inclusive numeric range as minimal aligned CIDR blocks.
   * Takes the largest aligned block that fits at each step.
   * @param {number} start
   * @param {number} end
   * @returns {Array<{address:number,prefix:number}>}
   */
  function coverRange(start, end) {
    var s = start >>> 0;
    var e = end >>> 0;
    var out = [];
    var guard = 0;
    while (s <= e && guard < 64) {
      var maxSize = 1;
      // Grow while the block stays aligned and within the remaining range.
      while (maxSize * 2 <= (e - s + 1) && s % (maxSize * 2) === 0) {
        maxSize *= 2;
      }
      var prefix = 32 - Math.round(Math.log2(maxSize));
      out.push({ address: s, prefix: prefix });
      s = s + maxSize;
      guard++;
      if (s === 0) break; // wrapped past 2^32
    }
    return out;
  }

  /**
   * Merge adjacent or overlapping blocks into the smallest covering set of
   * aligned CIDR blocks.
   *
   * The sweep works on numeric ranges: blocks are normalized to their network
   * address, sorted, and consecutive blocks are grouped while they overlap or
   * sit exactly end-to-start. Each group's span is then expressed as the
   * fewest aligned CIDR blocks (so two /25 halves collapse to a /24). Blocks
   * separated by an unlisted gap stay separate.
   * @param {string} text
   * @returns {{ok:true,input:string[],merged:Array<object>}|{ok:false,error:string}}
   */
  function mergeList(text) {
    var parsed = parseList(text);
    if (!parsed.ok) return parsed;
    if (parsed.blocks.length === 0) {
      return { ok: false, error: "Enter at least one CIDR block to merge (e.g. 10.0.0.0/24)." };
    }

    var sorted = sortBlocks(parsed.blocks).map(function (b) {
      return {
        start: networkAddress(b.address, b.prefix),
        end: broadcastAddress(b.address, b.prefix)
      };
    });

    // Group touching or overlapping ranges into maximal spans.
    var groups = [];
    for (var i = 0; i < sorted.length; i++) {
      var last = groups.length ? groups[groups.length - 1] : null;
      if (last && sorted[i].start <= last.end + 1) {
        last.end = Math.max(last.end, sorted[i].end);
      } else {
        groups.push({ start: sorted[i].start, end: sorted[i].end });
      }
    }

    var merged = [];
    groups.forEach(function (group) {
      coverRange(group.start, group.end).forEach(function (block) {
        merged.push(describeBlock(block.address, block.prefix));
      });
    });

    return {
      ok: true,
      input: parsed.blocks.map(function (b) {
        return toDotted(networkAddress(b.address, b.prefix)) + "/" + b.prefix;
      }),
      merged: merged
    };
  }

  /**
   * Check whether a single address falls inside any of the listed blocks.
   * @param {string} addressInput
   * @param {string} listText
   * @returns {{ok:true,address:string,matches:Array<object>}|{ok:false,error:string}}
   */
  function checkMembership(addressInput, listText) {
    var address = parseOctets(addressInput);
    if (address === null) {
      var prefix = looksLikeIPv6(addressInput) ? "IPv6 addresses are not supported. " : "";
      return { ok: false, error: prefix + "Enter a valid IPv4 address (e.g. 10.20.30.40)." };
    }
    var parsed = parseList(listText);
    if (!parsed.ok) return parsed;
    if (parsed.blocks.length === 0) {
      return { ok: false, error: "Enter at least one CIDR block to check against." };
    }
    var matches = [];
    for (var i = 0; i < parsed.blocks.length; i++) {
      var b = parsed.blocks[i];
      var net = networkAddress(b.address, b.prefix);
      if (address >= net && address <= broadcastAddress(b.address, b.prefix)) {
        matches.push(describeBlock(net, b.prefix));
      }
    }
    return { ok: true, address: toDotted(address), matches: matches };
  }

  /**
   * Format an address count with thousands separators (locale-independent).
   * @param {number} n
   * @returns {string}
   */
  function formatCount(n) {
    if (n === null || n === undefined || !isFinite(n)) return "—";
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  return {
    // primitives and parsing
    parseOctets: parseOctets,
    toDotted: toDotted,
    parsePrefix: parsePrefix,
    parseCidr: parseCidr,
    looksLikeIPv6: looksLikeIPv6,
    maskToPrefix: maskToPrefix,
    prefixToMask: prefixToMask,
    // block arithmetic
    networkAddress: networkAddress,
    broadcastAddress: broadcastAddress,
    totalAddresses: totalAddresses,
    usableAddresses: usableAddresses,
    hostRange: hostRange,
    // classification
    classify: classify,
    isPrivate: isPrivate,
    isLoopback: isLoopback,
    isMulticast: isMulticast,
    addressRole: addressRole,
    classfulLetter: classfulLetter,
    // reverse DNS
    reverseDns: reverseDns,
    reverseZone: reverseZone,
    // description / result
    describeBlock: describeBlock,
    calculate: calculate,
    // splitting
    prefixForHosts: prefixForHosts,
    splitBlock: splitBlock,
    splitInto: splitInto,
    splitByHosts: splitByHosts,
    // list operations
    parseList: parseList,
    sortBlocks: sortBlocks,
    coverRange: coverRange,
    mergeList: mergeList,
    checkMembership: checkMembership,
    // helpers
    formatCount: formatCount,
    SPECIAL_RANGES: SPECIAL_RANGES
  };
});