---
description: Pull the latest EGC repo changes and reinstall the current managed targets.
disable-model-invocation: true
---

# Auto Update

Update EGC from its upstream repo and regenerate the current context's managed install using the original install-state request.

## Usage

```bash
# Preview the update without mutating anything
ECC_ROOT="${GEMINI_PLUGIN_ROOT:-$(node -e "var r=(()=>{var e=process.env.GEMINI_PLUGIN_ROOT;if(e&&e.trim())return e.trim();var p=require('path'),f=require('fs'),h=require('os').homedir(),d=p.join(h,'.gemini'),q=p.join('scripts','lib','utils.js');if(f.existsSync(p.join(d,q)))return d;for(var s of [['egc'],['egc@egc'],['marketplace','egc'],['everything-gemini'],['everything-gemini@everything-gemini'],['marketplace','everything-gemini']]){var l=p.join(d,'plugins',...s);if(f.existsSync(p.join(l,q)))return l}try{for(var g of ['egc','everything-gemini']){var b=p.join(d,'plugins','cache',g);for(var o of f.readdirSync(b,{withFileTypes:true})){if(!o.isDirectory())continue;for(var v of f.readdirSync(p.join(b,o.name),{withFileTypes:true})){if(!v.isDirectory())continue;var c=p.join(b,o.name,v.name);if(f.existsSync(p.join(c,q)))return c}}}}catch(x){}return d})();console.log(r)")}"
node "$ECC_ROOT/scripts/auto-update.js" --dry-run

# Update only Cursor-managed files in the current project
node "$ECC_ROOT/scripts/auto-update.js" --target cursor

# Override the EGC repo root explicitly
node "$ECC_ROOT/scripts/auto-update.js" --repo-root /path/to/EGC
```

## Notes

- This command uses the recorded install-state request and reruns `install-apply.js` after pulling the latest repo changes.
- Reinstall is intentional: it handles upstream renames and deletions that `repair.js` cannot safely reconstruct from stale operations alone.
- Use `--dry-run` first if you want to see the reconstructed reinstall plan before mutating anything.
