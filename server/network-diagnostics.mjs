// Network diagnostics for WSL/HuggingFace CDN connectivity issues
// Run at startup to detect common problems and log actionable fixes

import dns from 'dns';
import { execSync } from 'child_process';

export function runNetworkDiagnostics() {
  const isWSL = process.platform === 'linux' && /microsoft|wsl/i.test(process.env.WSL_DISTRO_NAME || execSync('cat /proc/version 2>/dev/null || echo ""', { encoding: 'utf8' }));
  const issues = [];

  // 1. Check DNS resolution for HuggingFace CDN
  const hosts = ['huggingface.co', 'cdn.huggingface.co', 'xethub.hf.co'];
  for (const host of hosts) {
    const start = Date.now();
    try {
      const result = dns.resolve4(host);
      // resolve4 is sync in some Node versions, async in others
    } catch {
      // DNS resolution failed — serious issue
    }
    // Use lookup (sync-ish) for timing
    try {
      const before = Date.now();
      dns.resolve4(host, (err, addresses) => {
        const elapsed = Date.now() - before;
        if (err && elapsed < 10) {
          issues.push(`DNS resolve4 failed for ${host}: ${err.message}`);
        }
      });
    } catch {}
  }

  // 2. Check IPv4-first DNS setting
  if (!process.env.NODE_OPTIONS?.includes('ipv4first')) {
    issues.push('NODE_OPTIONS does not include --dns-result-order=ipv4first. WSL IPv6 may route to slow CDN nodes.');
  }

  // 3. Check WSL-specific issues
  if (isWSL) {
    try {
      const resolv = execSync('cat /etc/resolv.conf 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
      if (resolv.includes('nameserver 172.')) {
        // Default WSL2 NAT — usually works but can be slow
      }
      if (!resolv.includes('nameserver')) {
        issues.push('WSL: No nameserver found in /etc/resolv.conf');
      }
    } catch {}
  }

  // Log results
  if (issues.length > 0) {
    console.warn('Network diagnostics detected issues:');
    for (const issue of issues) {
      console.warn(`  - ${issue}`);
    }
    if (isWSL) {
      console.warn('WSL fixes to try:');
      console.warn('  1. Set in noxem-launcher.sh (already done if using launcher)');
      console.warn('  2. Add to /etc/wsl.conf: [network] generateResolvConf=false, then set nameserver 8.8.8.8 in /etc/resolv.conf');
      console.warn('  3. Set env: HF_FETCH_TIMEOUT=120000 (already patched in server)');
      console.warn('  4. Try: export NODE_OPTIONS="--dns-result-order=ipv4first" before node');
    }
  } else {
    console.log('Network diagnostics: OK (IPv4-first DNS set)');
  }

  return issues;
}
