import os
import json
import logging
from typing import List, Dict, Optional

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger("EGC.Router")

class AGENT_ROUTER:
    """
    EGC Agent Router
    Responsible for selecting the best agent for a given task based on affinity.
    """

    def __init__(self, project_root: str = "."):
        self.project_root = project_root
        self.affinity_map_path = os.path.join(project_root, "AGENT_AFFINITY_MAP.json")
        canonical = os.path.join(project_root, "internal", "registry", "runtime-map.json")
        legacy = os.path.join(project_root, "registry", "runtime-map.json")
        self.runtime_map_path = canonical if os.path.exists(canonical) else legacy
        self.affinity_map = self._load_json(self.affinity_map_path)
        self.runtime_map = self._load_json(self.runtime_map_path)
        
        # Domain Keywords for basic matching
        self.domain_keywords = {
            "backend_python_api": ["python", "api", "backend", "fastapi", "django", "flask"],
            "frontend_flutter": ["flutter", "dart", "mobile", "frontend", "ui", "widget"],
            "system_rust": ["rust", "system", "performance", "low-level", "memory"],
            "ml_pipeline": ["ml", "ai", "data", "pipeline", "pytorch", "tensorflow", "training"]
        }

    def _load_json(self, path: str) -> Dict:
        if not os.path.exists(path):
            logger.warning(f"File not found: {path}")
            return {}
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            logger.error(f"Error loading {path}: {str(e)}")
            return {}

    def _detect_domain(self, task_description: str) -> str:
        import re
        task_lower = task_description.lower()
        scores = {domain: 0 for domain in self.domain_keywords}
        
        for domain, keywords in self.domain_keywords.items():
            for kw in keywords:
                # Use word boundaries to avoid partial matches (e.g., 'ai' in 'repair')
                pattern = r'\b' + re.escape(kw) + r'\b'
                if re.search(pattern, task_lower):
                    scores[domain] += 1
        
        best_domain = max(scores, key=scores.get)
        if scores[best_domain] == 0:
            return "general"
        return best_domain

    def get_best_agent(self, task_description: str, confidence_threshold: int = 1) -> Optional[Dict]:
        """
        Selects the best physical agent for the task.
        """
        logger.info(f"Routing task: {task_description[:50]}...")
        domain = self._detect_domain(task_description)
        logger.info(f"Detected domain: {domain}")

        potential_agents = self.affinity_map.get("domains", {}).get(domain, ["architect"])
        
        # Specialist Matching: check if task keywords match agent slug parts
        task_lower = task_description.lower()
        for agent_slug in potential_agents:
            # Check if all words in the agent slug (split by -) are represented in the task
            # We strip 'er', 'or', 'ist' etc. for basic stemming
            slug_parts = [p.replace("reviewer", "review").replace("specialist", "special") for p in agent_slug.split("-")]
            if all(part in task_lower for part in slug_parts):
                agent_info = self._resolve_physical_agent(agent_slug)
                if agent_info:
                    logger.info(f"Selected specialist agent: {agent_slug}")
                    return agent_info

        # Default domain matching
        for agent_slug in potential_agents:
            agent_info = self._resolve_physical_agent(agent_slug)
            if agent_info:
                logger.info(f"Selected domain agent: {agent_slug}")
                return agent_info
        
        # Ultimate fallback
        logger.warning("No domain-specific agent found, falling back to architect.")
        return self._resolve_physical_agent("architect")

    def _resolve_physical_agent(self, slug: str) -> Optional[Dict]:
        """
        Resolves a slug to physical agent metadata from runtime-map.json.
        Ignores virtual aliases.
        """
        filename = f"{slug}.md" if not slug.endswith(".md") else slug
        
        for agent in self.runtime_map.get("agents", []):
            if agent["name"] == filename:
                return {
                    "id": slug.replace(".md", ""),
                    "name": agent["name"],
                    "physicalPath": agent["physicalPath"],
                    "status": agent["status"]
                }
        return None

if __name__ == "__main__":
    # Quick CLI test
    router = AGENT_ROUTER()
    test_task = "Create a new FastAPI endpoint for user registration"
    best = router.get_best_agent(test_task)
    print(f"TASK: {test_task}")
    print(f"RESULT: {json.dumps(best, indent=2)}")
