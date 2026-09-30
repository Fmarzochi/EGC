---
description: Pull the latest EGC repo changes and reinstall the current managed targets.
disable-model-invocation: true
---

# Auto Update

Update EGC from its upstream repo and regenerate the current context's managed install using the original install-state request.

## Usage

```bash
# Preview the update without mutating anything
EGC_ROOT="$(node -e "console.log(((q)=>{var v=process.env,p=require('path'),f=require('fs'),h=require('os').homedir(),x=function(d){return d&&f.existsSync(p.join(d,q))},e=v.EGC_PLUGIN_ROOT||v.ECC_PLUGIN_ROOT||v.GEMINI_PLUGIN_ROOT;if(e&&e.trim())return e.trim();var t=v.GEMINI_PROJECT_DIR||v.GEMINI_PLUGIN_ROOT?'.gemini':v.CLAUDECODE||v.CLAUDE_PROJECT_DIR||v.CLAUDE_PLUGIN_ROOT?'.claude':v.CODEBUDDY_PROJECT_DIR||v.CODEBUDDY_PLUGIN_ROOT?'.codebuddy':v.VSCODE_AGENT||v.GITHUB_COPILOT_API_TOKEN?'.github':v.KIRO_HOOK_FILE||v.KIRO_FILE_PATH?'.kiro':v.TRAE_ENV?(v.TRAE_ENV==='cn'?'.trae-cn':'.trae'):'',k=p.join(h,'.claude','plugins');for(var d of [(v.CLAUDE_PLUGIN_ROOT||'').trim(),v.EGC_DIR,t&&p.join(h,t),p.join(k,'egc'),p.join(k,'egc@egc'),p.join(k,'marketplace','egc'),p.join(k,'everything-gemini'),p.join(k,'everything-gemini@everything-gemini'),p.join(k,'marketplace','everything-gemini')]){if(x(d))return d}for(var g of ['egc','everything-gemini']){var b=p.join(k,'cache',g);try{for(var o of f.readdirSync(b,{withFileTypes:true})){if(o.isDirectory()){for(var w of f.readdirSync(p.join(b,o.name),{withFileTypes:true})){var c=p.join(b,o.name,w.name);if(w.isDirectory()&&x(c))return c}}}}catch(z){}}for(var s of (v.PATH||'').split(p.delimiter)){if(s){try{var g=p.join(s,'egc');if(f.existsSync(g)){var r=p.resolve(p.dirname(f.realpathSync(g)),'..');if(x(r))return r}}catch(z){}var n=p.join(s,'node_modules','@egchq','egc');if(x(n))return n}}for(var u of [['.claude'],['.gemini'],['.codeium','windsurf'],['.config','opencode'],['.cursor'],['.codebuddy'],['.egc']]){var m=p.join(h,...u);if(x(m))return m}return p.join(h,'.egc')})('scripts/auto-update.js'))")"
node "$EGC_ROOT/scripts/auto-update.js" --dry-run

# Update only Cursor-managed files in the current project
node "$EGC_ROOT/scripts/auto-update.js" --target cursor

# Override the EGC repo root explicitly
node "$EGC_ROOT/scripts/auto-update.js" --repo-root /path/to/EGC
```

## Notes

- This command uses the recorded install-state request and reruns `install-apply.js` after pulling the latest repo changes.
- Reinstall is intentional: it handles upstream renames and deletions that `repair.js` cannot safely reconstruct from stale operations alone.
- Use `--dry-run` first if you want to see the reconstructed reinstall plan before mutating anything.
