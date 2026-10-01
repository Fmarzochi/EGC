---
name: skill-health
description: Show skill portfolio health dashboard with charts and analytics
command: true
---

# Skill Health Dashboard

Shows a comprehensive health dashboard for all skills in the portfolio with success rate sparklines, failure pattern clustering, pending amendments, and version history.

## Implementation

Run the skill health CLI in dashboard mode:

```bash
EGC_ROOT="$(node -e "console.log(((q)=>{var v=process.env,p=require('path'),f=require('fs'),h=require('os').homedir(),x=function(d){return d&&f.existsSync(p.join(d,q))},e=(v.EGC_PLUGIN_ROOT||v.ECC_PLUGIN_ROOT||v.GEMINI_PLUGIN_ROOT||'').trim(),t=v.GEMINI_PROJECT_DIR||v.GEMINI_PLUGIN_ROOT?'.gemini':v.CLAUDECODE||v.CLAUDE_PROJECT_DIR||v.CLAUDE_PLUGIN_ROOT?'.claude':v.CODEBUDDY_PROJECT_DIR||v.CODEBUDDY_PLUGIN_ROOT?'.codebuddy':v.VSCODE_AGENT||v.GITHUB_COPILOT_API_TOKEN?'.github':v.KIRO_HOOK_FILE||v.KIRO_FILE_PATH?'.kiro':v.TRAE_ENV?(v.TRAE_ENV==='cn'?'.trae-cn':'.trae'):'',k=p.join(h,'.claude','plugins');for(var d of [e,(v.CLAUDE_PLUGIN_ROOT||'').trim(),v.EGC_DIR,t&&p.join(h,t),p.join(k,'egc'),p.join(k,'egc@egc'),p.join(k,'marketplace','egc'),p.join(k,'everything-gemini'),p.join(k,'everything-gemini@everything-gemini'),p.join(k,'marketplace','everything-gemini')]){if(x(d))return d}for(var g of ['egc','everything-gemini']){var b=p.join(k,'cache',g);try{for(var o of f.readdirSync(b,{withFileTypes:true})){if(o.isDirectory()){for(var w of f.readdirSync(p.join(b,o.name),{withFileTypes:true})){var c=p.join(b,o.name,w.name);if(w.isDirectory()&&x(c))return c}}}}catch(z){}}for(var s of (v.PATH||'').split(p.delimiter)){if(s){try{var g=p.join(s,'egc');if(f.existsSync(g)){var r=p.resolve(p.dirname(f.realpathSync(g)),'..');if(x(r))return r}}catch(z){}var n=p.join(s,'node_modules','@egchq','egc');if(x(n))return n}}for(var u of [['.codeium','windsurf'],['.config','opencode'],['.config','zed'],['.gemini'],['.claude'],['.cursor'],['.agents'],['.amp'],['.continue'],['.github'],['.kiro'],['.trae'],['.trae-cn'],['.codebuddy'],['.egc']]){var m=p.join(h,...u);if(x(m))return m}return p.join(h,'.egc')})('scripts/skills-health.js'))")"
node "$EGC_ROOT/scripts/skills-health.js" --dashboard
```

For a specific panel only:

```bash
EGC_ROOT="$(node -e "console.log(((q)=>{var v=process.env,p=require('path'),f=require('fs'),h=require('os').homedir(),x=function(d){return d&&f.existsSync(p.join(d,q))},e=(v.EGC_PLUGIN_ROOT||v.ECC_PLUGIN_ROOT||v.GEMINI_PLUGIN_ROOT||'').trim(),t=v.GEMINI_PROJECT_DIR||v.GEMINI_PLUGIN_ROOT?'.gemini':v.CLAUDECODE||v.CLAUDE_PROJECT_DIR||v.CLAUDE_PLUGIN_ROOT?'.claude':v.CODEBUDDY_PROJECT_DIR||v.CODEBUDDY_PLUGIN_ROOT?'.codebuddy':v.VSCODE_AGENT||v.GITHUB_COPILOT_API_TOKEN?'.github':v.KIRO_HOOK_FILE||v.KIRO_FILE_PATH?'.kiro':v.TRAE_ENV?(v.TRAE_ENV==='cn'?'.trae-cn':'.trae'):'',k=p.join(h,'.claude','plugins');for(var d of [e,(v.CLAUDE_PLUGIN_ROOT||'').trim(),v.EGC_DIR,t&&p.join(h,t),p.join(k,'egc'),p.join(k,'egc@egc'),p.join(k,'marketplace','egc'),p.join(k,'everything-gemini'),p.join(k,'everything-gemini@everything-gemini'),p.join(k,'marketplace','everything-gemini')]){if(x(d))return d}for(var g of ['egc','everything-gemini']){var b=p.join(k,'cache',g);try{for(var o of f.readdirSync(b,{withFileTypes:true})){if(o.isDirectory()){for(var w of f.readdirSync(p.join(b,o.name),{withFileTypes:true})){var c=p.join(b,o.name,w.name);if(w.isDirectory()&&x(c))return c}}}}catch(z){}}for(var s of (v.PATH||'').split(p.delimiter)){if(s){try{var g=p.join(s,'egc');if(f.existsSync(g)){var r=p.resolve(p.dirname(f.realpathSync(g)),'..');if(x(r))return r}}catch(z){}var n=p.join(s,'node_modules','@egchq','egc');if(x(n))return n}}for(var u of [['.codeium','windsurf'],['.config','opencode'],['.config','zed'],['.gemini'],['.claude'],['.cursor'],['.agents'],['.amp'],['.continue'],['.github'],['.kiro'],['.trae'],['.trae-cn'],['.codebuddy'],['.egc']]){var m=p.join(h,...u);if(x(m))return m}return p.join(h,'.egc')})('scripts/skills-health.js'))")"
node "$EGC_ROOT/scripts/skills-health.js" --dashboard --panel failures
```

For machine-readable output:

```bash
EGC_ROOT="$(node -e "console.log(((q)=>{var v=process.env,p=require('path'),f=require('fs'),h=require('os').homedir(),x=function(d){return d&&f.existsSync(p.join(d,q))},e=(v.EGC_PLUGIN_ROOT||v.ECC_PLUGIN_ROOT||v.GEMINI_PLUGIN_ROOT||'').trim(),t=v.GEMINI_PROJECT_DIR||v.GEMINI_PLUGIN_ROOT?'.gemini':v.CLAUDECODE||v.CLAUDE_PROJECT_DIR||v.CLAUDE_PLUGIN_ROOT?'.claude':v.CODEBUDDY_PROJECT_DIR||v.CODEBUDDY_PLUGIN_ROOT?'.codebuddy':v.VSCODE_AGENT||v.GITHUB_COPILOT_API_TOKEN?'.github':v.KIRO_HOOK_FILE||v.KIRO_FILE_PATH?'.kiro':v.TRAE_ENV?(v.TRAE_ENV==='cn'?'.trae-cn':'.trae'):'',k=p.join(h,'.claude','plugins');for(var d of [e,(v.CLAUDE_PLUGIN_ROOT||'').trim(),v.EGC_DIR,t&&p.join(h,t),p.join(k,'egc'),p.join(k,'egc@egc'),p.join(k,'marketplace','egc'),p.join(k,'everything-gemini'),p.join(k,'everything-gemini@everything-gemini'),p.join(k,'marketplace','everything-gemini')]){if(x(d))return d}for(var g of ['egc','everything-gemini']){var b=p.join(k,'cache',g);try{for(var o of f.readdirSync(b,{withFileTypes:true})){if(o.isDirectory()){for(var w of f.readdirSync(p.join(b,o.name),{withFileTypes:true})){var c=p.join(b,o.name,w.name);if(w.isDirectory()&&x(c))return c}}}}catch(z){}}for(var s of (v.PATH||'').split(p.delimiter)){if(s){try{var g=p.join(s,'egc');if(f.existsSync(g)){var r=p.resolve(p.dirname(f.realpathSync(g)),'..');if(x(r))return r}}catch(z){}var n=p.join(s,'node_modules','@egchq','egc');if(x(n))return n}}for(var u of [['.codeium','windsurf'],['.config','opencode'],['.config','zed'],['.gemini'],['.claude'],['.cursor'],['.agents'],['.amp'],['.continue'],['.github'],['.kiro'],['.trae'],['.trae-cn'],['.codebuddy'],['.egc']]){var m=p.join(h,...u);if(x(m))return m}return p.join(h,'.egc')})('scripts/skills-health.js'))")"
node "$EGC_ROOT/scripts/skills-health.js" --dashboard --json
```

## Usage

```
/skill-health                    # Full dashboard view
/skill-health --panel failures   # Only failure clustering panel
/skill-health --json             # Machine-readable JSON output
```

## What to Do

1. Run the skills-health.js script with --dashboard flag
2. Display the output to the user
3. If any skills are declining, highlight them and suggest running /evolve
4. If there are pending amendments, suggest reviewing them

## Panels

- **Success Rate (30d)**: Sparkline charts showing daily success rates per skill
- **Failure Patterns**: Clustered failure reasons with horizontal bar chart
- **Pending Amendments**: Amendment proposals awaiting review
- **Version History**: Timeline of version snapshots per skill
