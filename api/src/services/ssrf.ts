import { promises as dns } from "node:dns";
import { isIP } from "node:net";

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

// Private IP ranges (CIDR notation)
const PRIVATE_IPV4_RANGES = [
  { start: [10, 0, 0, 0], end: [10, 255, 255, 255] },           // 10.0.0.0/8
  { start: [172, 16, 0, 0], end: [172, 31, 255, 255] },         // 172.16.0.0/12
  { start: [192, 168, 0, 0], end: [192, 168, 255, 255] },       // 192.168.0.0/16
  { start: [127, 0, 0, 0], end: [127, 255, 255, 255] },         // 127.0.0.0/8 (loopback)
  { start: [169, 254, 0, 0], end: [169, 254, 255, 255] },       // 169.254.0.0/16 (link-local)
  { start: [0, 0, 0, 0], end: [0, 255, 255, 255] },             // 0.0.0.0/8 (non-routable)
  { start: [100, 64, 0, 0], end: [100, 127, 255, 255] },        // 100.64.0.0/10 (CGNAT, RFC 6598)
];

// Cloud metadata IP
const CLOUD_METADATA_IP = "169.254.169.254";

// Blocked hostnames
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "0.0.0.0",
]);

function ipv4ToOctets(ip: string): number[] {
  const parts = ip.split(".");
  
  // Ensure exactly 4 octets
  if (parts.length !== 4) {
    throw new SsrfError(`Invalid IPv4 address (expected 4 octets): "${ip}"`);
  }
  
  const octets: number[] = [];
  
  for (const part of parts) {
    // Each octet must be digits only
    if (!/^\d+$/.test(part)) {
      throw new SsrfError(`Invalid IPv4 address (non-numeric octet): "${ip}"`);
    }
    
    const value = Number(part);
    
    // Each octet must be within 0-255
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw new SsrfError(`Invalid IPv4 address (octet out of range 0-255): "${ip}"`);
    }
    
    octets.push(value);
  }
  
  return octets;
}

function ipv4OctetsToInt(octets: number[]): number {
  // Convert 4 octets to a single 32-bit integer for easy comparison
  return (
    ((octets[0] & 0xff) << 24) |
    ((octets[1] & 0xff) << 16) |
    ((octets[2] & 0xff) << 8) |
    (octets[3] & 0xff)
  ) >>> 0; // Unsigned right shift to ensure positive number
}

function isIpv4InRange(ip: string, range: { start: number[]; end: number[] }): boolean {
  const octets = ipv4ToOctets(ip);
  const ipInt = ipv4OctetsToInt(octets);
  const startInt = ipv4OctetsToInt(range.start);
  const endInt = ipv4OctetsToInt(range.end);
  
  return ipInt >= startInt && ipInt <= endInt;
}

function isPrivateIpv4(ip: string): boolean {
  // Check cloud metadata IP specifically
  if (ip === CLOUD_METADATA_IP) {
    return true;
  }
  
  // Check private ranges
  for (const range of PRIVATE_IPV4_RANGES) {
    if (isIpv4InRange(ip, range)) {
      return true;
    }
  }
  
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const lowerIp = ip.toLowerCase();
  
  // Loopback (::1/128)
  if (lowerIp === "::1") {
    return true;
  }
  
  // Extract first hextet for range checks
  const firstHextet = lowerIp.split(":")[0];
  
  // Unique local addresses (fc00::/7, includes fc00::/8 and fd00::/8)
  if (firstHextet.startsWith("fc") || firstHextet.startsWith("fd")) {
    return true;
  }
  
  // Deprecated site-local addresses (fec0::/10)
  const firstHextetNum = parseInt(firstHextet, 16);
  if (!Number.isNaN(firstHextetNum) && firstHextetNum >= 0xfec0 && firstHextetNum <= 0xfeff) {
    return true;
  }
  
  // Link-local (fe80::/10) - must check numerically for full range
  // fe80::/10 covers fe80:: through febf::
  if (firstHextetNum >= 0xfe80 && firstHextetNum <= 0xfebf) {
    return true;
  }
  
  // IPv4-mapped IPv6 addresses (::ffff:x.x.x.x)
  if (lowerIp.includes("::ffff:")) {
    const ipv4Part = lowerIp.split("::ffff:")[1];
    if (ipv4Part) {
      return isPrivateIpv4(ipv4Part);
    }
  }
  
  return false;
}

function isPrivateIp(ip: string): boolean {
  // Strip brackets from IPv6 addresses if present
  let cleanIp = ip;
  if (ip.startsWith("[") && ip.endsWith("]")) {
    cleanIp = ip.slice(1, -1);
  }
  
  if (cleanIp.includes(":")) {
    return isPrivateIpv6(cleanIp);
  }
  return isPrivateIpv4(cleanIp);
}

export async function validateUrl(url: string): Promise<{ hostname: string; resolvedIp: string; port: number }> {
  // Parse URL
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfError("Invalid URL format");
  }
  
  // Only allow http and https
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SsrfError(`Protocol not allowed: ${parsed.protocol}`);
  }
  
  let hostname = parsed.hostname;
  
  // Check blocked hostnames
  if (BLOCKED_HOSTNAMES.has(hostname.toLowerCase())) {
    throw new SsrfError(`Blocked hostname: ${hostname}`);
  }
  
  // If hostname is already an IP, validate it directly
  // For IPv6 addresses, the hostname will have brackets which we need to strip for validation
  let ipToValidate = hostname;
  
  const ipVersion = isIP(hostname);

  if (ipVersion !== 0) {
    if (isPrivateIp(ipToValidate)) {
      throw new SsrfError(`Private IP address not allowed: ${ipToValidate}`);
    }
    
    const port = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === "https:" ? 443 : 80);
    return { hostname, resolvedIp: ipToValidate, port };
  }
  
  // DNS rebinding defense: resolve hostname to IP
  let resolvedIp: string;
  try {
    const result = await dns.lookup(hostname, { family: 0 }); // 0 = IPv4 or IPv6
    resolvedIp = result.address;
  } catch (error) {
    throw new SsrfError(`DNS lookup failed for ${hostname}: ${error instanceof Error ? error.message : String(error)}`);
  }
  
  // Validate the resolved IP
  if (isPrivateIp(resolvedIp)) {
    throw new SsrfError(`Hostname ${hostname} resolves to private IP: ${resolvedIp}`);
  }
  
  const port = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === "https:" ? 443 : 80);
  
  return { hostname, resolvedIp, port };
}
