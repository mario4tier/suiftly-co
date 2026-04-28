// TLS endpoints monitored by the Certs admin page.
// Source: ~/mhaxbe/NETWORK_MAP.md.
//
// Pipeline A: HAProxy-terminated *.mhax.io / *.matrical.top services. Cert
// served by HAProxy on each public proxy IP (port 443) using acme.sh stateless.
//
// Pipeline B: Walrus storage node TLS on port 9185. The proxy IP runs HAProxy
// in TCP-passthrough mode forwarding to home WAN 1{9,29}185 -> turin. Cert is
// renewed by certbot --standalone on turin via the home port-80 path.
//
// Pipeline C: *.suiftly.io services fronted by Cloudflare Tunnel. Cert is
// Cloudflare's universal SSL (`*.suiftly.io`); we don't renew it but we still
// monitor handshake health since a tunnel/DNS misconfiguration would surface
// here. Probe by FQDN — DNS resolves to a Cloudflare Anycast edge IP.
//
// `proxies` is kept as an array even when only one entry is currently active,
// so the schema scales to the future case of one FQDN fanning out to multiple
// backend IPs (web farm). Set `ip` to a literal IP to pin the probe; omit it
// to let DNS resolve (used for Cloudflare-fronted services).

export interface CertProxy {
  provider: string;
  ip?: string;
}

export interface CertTarget {
  fqdn: string;
  port: number;
  pipeline: 'A' | 'B' | 'C';
  proxies: CertProxy[];
}

export const CERT_TARGETS: CertTarget[] = [
  {
    fqdn: 'suiftly.mhax.io',
    port: 443,
    pipeline: 'A',
    proxies: [{ provider: 'OVH', ip: '51.81.4.78' }],
  },
  {
    fqdn: 'suiftly-testnet-agg.mhax.io',
    port: 443,
    pipeline: 'A',
    proxies: [{ provider: 'OVH', ip: '51.81.4.77' }],
  },
  {
    fqdn: 'suiftly-testnet-pub.mhax.io',
    port: 443,
    pipeline: 'A',
    proxies: [{ provider: 'OVH', ip: '15.204.178.222' }],
  },
  {
    fqdn: 'stagg.matrical.top',
    port: 443,
    pipeline: 'A',
    proxies: [{ provider: 'OVH', ip: '51.81.4.77' }],
  },
  {
    fqdn: 'sagg.matrical.top',
    port: 443,
    pipeline: 'A',
    proxies: [{ provider: 'OVH', ip: '51.81.4.78' }],
  },
  {
    fqdn: 'suiftly-node.mhax.io',
    port: 9185,
    pipeline: 'B',
    proxies: [{ provider: 'OVH', ip: '15.204.155.205' }],
  },
  {
    fqdn: 'suiftly-testnet-node.mhax.io',
    port: 9185,
    pipeline: 'B',
    proxies: [{ provider: 'OVH', ip: '15.204.184.195' }],
  },
  {
    fqdn: 'seal-mainnet.suiftly.io',
    port: 443,
    pipeline: 'C',
    proxies: [{ provider: 'Cloudflare' }],
  },
  {
    fqdn: 'seal-testnet.suiftly.io',
    port: 443,
    pipeline: 'C',
    proxies: [{ provider: 'Cloudflare' }],
  },
  {
    fqdn: 'seal-testnet-open.suiftly.io',
    port: 443,
    pipeline: 'C',
    proxies: [{ provider: 'Cloudflare' }],
  },
  {
    fqdn: 'ssfn-mainnet.suiftly.io',
    port: 443,
    pipeline: 'C',
    proxies: [{ provider: 'Cloudflare' }],
  },
];
