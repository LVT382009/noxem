import sys, os

_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', 'noxem-launcher.sh')
with open(_path, 'r', encoding='utf-8', newline='') as f:
    lines = f.readlines()

# Replace lines 500-508 (0-indexed): CDP script section
start = None
for i, line in enumerate(lines):
    if '# Run CDP login helper to extract session state' in line:
        start = i
        break

# Find end: the LOGIN_EXIT=$? line
end = None
if start:
    for i in range(start, min(start + 15, len(lines))):
        if 'LOGIN_EXIT=$?' in lines[i]:
            end = i
            break

if start and end and end > start:
    indent1 = '\t\t'
    indent2 = '\t\t\t'
    new_lines = [
        f'{indent1}# Run CDP login helper to extract session state\n',
        f'{indent1}# Copy script into DeepSProxy dir so it can resolve the "playwright" npm package\n',
        f'{indent1}_cdp_script="$NOXEM_DIR/scripts/cdp-login.mjs"\n',
        f'{indent1}if [ -f "$_cdp_script" ]; then\n',
        f'{indent2}dim "  Running CDP login helper..."\n',
        f'{indent2}cp "$_cdp_script" "$DSP_DIR/cdp-login.mjs" 2>/dev/null\n',
        f'{indent2}(cd "$DSP_DIR" && node cdp-login.mjs \\\n',
        f'\t\t\t\t--cdp-host="$_win_host_ip" \\\n',
        f'\t\t\t\t--cdp-port="$_cdp_port" \\\n',
        f'\t\t\t\t--profile-dir="$DSP_PROFILE")\n',
        f'{indent2}LOGIN_EXIT=$?\n',
        f'{indent2}rm -f "$DSP_DIR/cdp-login.mjs" 2>/dev/null\n',
    ]

    lines = lines[:start] + new_lines + lines[end+1:]
    with open(_path, 'w', encoding='utf-8', newline='') as f:
        f.writelines(lines)
    print(f'Replaced lines {start+1}-{end+1} with copy-into-DSP-dir approach')
else:
    print(f'ERROR: start={start}, end={end}')
