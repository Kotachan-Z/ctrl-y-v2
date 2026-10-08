function isIP(address: string): 4 | 6 | 0 {
  if (!address.includes(":")) {
    const octets = address.split(".");
    return octets.length === 4 &&
      octets.every((octet) => /^(0|[1-9][0-9]{0,2})$/.test(octet) && Number(octet) <= 255)
      ? 4
      : 0;
  }
  // URL.hostname converts embedded IPv4 tails to hextets before calling this guard.
  const halves = address.split("::");
  if (halves.length > 2) return 0;
  const groups = halves.flatMap((half) => (half === "" ? [] : half.split(":")));
  if (!groups.every((group) => /^[0-9a-fA-F]{1,4}$/.test(group))) return 0;
  return (halves.length === 2 ? groups.length < 8 : groups.length === 8) ? 6 : 0;
}

function ipv4Value(address: string): number {
  return address.split(".").reduce((value, octet) => (value << 8) | Number(octet), 0) >>> 0;
}

function ipv6Value(address: string): bigint {
  const halves = address.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const groups =
    halves.length === 2
      ? [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right]
      : left;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function matchesIpv4Subnet(address: number, base: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) === (base & mask);
}

function matchesIpv6Subnet(address: bigint, base: bigint, prefix: number): boolean {
  const shift = BigInt(128 - prefix);
  return address >> shift === base >> shift;
}

const nonPublicIpv4 = (
  [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 3],
  ] as const
).map(([address, prefix]) => [ipv4Value(address), prefix] as const);
const globalIpv6 = ipv6Value("2000::");
const nonPublicIpv6 = (
  [
    ["2001::", 23], // Special-purpose protocols, including Teredo.
    ["2001:db8::", 32],
    ["2002::", 16], // 6to4 can embed a private IPv4 destination.
    ["3fff::", 20],
  ] as const
).map(([address, prefix]) => [ipv6Value(address), prefix] as const);
export function isPublicPushHost(url: URL): boolean {
  // URL canonicalizes alternate IPv4 spellings and compressed IPv6 before this check.
  // Defense in depth only: DNS rebinding to a private IP at send time is a separate,
  // harder problem that this literal-address check does not solve.
  const hostname = url.hostname.replace(/\.$/, "");
  const address = hostname.replace(/^\[|\]$/g, "");
  const version = isIP(address);
  if (version === 4) {
    const value = ipv4Value(address);
    return !nonPublicIpv4.some(([base, prefix]) => matchesIpv4Subnet(value, base, prefix));
  }
  if (version === 6) {
    const value = ipv6Value(address);
    return (
      matchesIpv6Subnet(value, globalIpv6, 3) &&
      !nonPublicIpv6.some(([base, prefix]) => matchesIpv6Subnet(value, base, prefix))
    );
  }
  return (
    hostname.includes(".") &&
    !["localhost", "local", "internal", "lan", "home.arpa"].some(
      (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
    )
  );
}
