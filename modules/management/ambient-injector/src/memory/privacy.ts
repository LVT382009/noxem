interface SecretMatch {
  pattern: string;
  match: string;
  type: string;
}

const SECRET_PATTERNS: Array<{ pattern: RegExp; type: string }> = [
  { pattern: /sk-proj-[a-zA-Z0-9]{20,}/g, type: "OpenAI project key" },
  { pattern: /sk-[a-zA-Z0-9]{20,}/g, type: "OpenAI API key" },
  { pattern: /ghp_[a-zA-Z0-9]{36}/g, type: "GitHub token" },
  { pattern: /gho_[a-zA-Z0-9]{36}/g, type: "GitHub OAuth token" },
  { pattern: /ghs_[a-zA-Z0-9]{36}/g, type: "GitHub app token" },
  { pattern: /ghu_[a-zA-Z0-9]{36}/g, type: "GitHub user-to-server token" },
  { pattern: /xox[bpas]-[a-zA-Z0-9-]+/g, type: "Slack token" },
  { pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g, type: "Private key" },
  { pattern: /mongodb(?:\+srv)?:\/\/[^\s"']+/g, type: "MongoDB connection string" },
  { pattern: /postgres(?:ql)?:\/\/[^\s"']+/g, type: "PostgreSQL connection string" },
  { pattern: /mysql:\/\/[^\s"']+/g, type: "MySQL connection string" },
  { pattern: /redis:\/\/[^\s"']+/g, type: "Redis connection string" },
  { pattern: /AKIA[0-9A-Z]{16}/g, type: "AWS access key" },
  { pattern: /AIza[0-9A-Za-z_-]{35}/g, type: "Google API key" },
  { pattern: /whsec_[a-zA-Z0-9]+/g, type: "Webhook secret" },
  { pattern: /password\s*[=:]\s*["'][^"']{4,}["']/gi, type: "Password in assignment" },
  { pattern: /Bearer\s+[a-zA-Z0-9\-._~+/]+=*/g, type: "Bearer token" },
];

export function scanForSecrets(text: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  for (const { pattern, type } of SECRET_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = re.exec(text)) !== null) {
      matches.push({ pattern: pattern.source, match: match[0], type });
    }
  }
  return matches;
}

export function redactSecrets(text: string): { redacted: string; found: SecretMatch[] } {
  const found = scanForSecrets(text);
  let redacted = text;
  for (const m of found) {
    redacted = redacted.replaceAll(m.match, `[REDACTED:${m.type}]`);
  }
  return { redacted, found };
}
