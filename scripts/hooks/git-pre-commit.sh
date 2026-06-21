#!/usr/bin/env bash
    MODE=$(git ls-files --stage "$FILE" | awk '{print $1}')
    git update-index --cacheinfo "${MODE},${CLEAN_HASH},${FILE}"
    echo "[egc] stripped local state block from $FILE"
  fi
done <<< "$STAGED"

exit 0
