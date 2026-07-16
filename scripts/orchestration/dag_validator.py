import logging

logger = logging.getLogger("EGC.DAGValidator")

class DAG_VALIDATOR:
    """
    EGC DAG Validator
    Ensures that orchestration chains are safe, acyclic, and within defined limits.
    """

    MAX_RECURSION_DEPTH = 2
    MAX_AGENT_CHAIN = 5

    def validate_workflow(self, workflow_chain: list) -> bool:
        """
        Validates a proposed agent execution chain.
        workflow_chain: List of agent IDs (slugs).
        """
        if not workflow_chain:
            logger.warning("Empty workflow chain provided.")
            return True

        # 1. Chain Length Check
        if len(workflow_chain) > self.MAX_AGENT_CHAIN:
            logger.error(f"Workflow rejected: Chain length {len(workflow_chain)} exceeds max {self.MAX_AGENT_CHAIN}")
            return False

        # 2. Self-Reference / Cycle Check (Immediate)
        seen = set()
        for i, agent_id in enumerate(workflow_chain):
            if agent_id in seen:
                logger.error(f"Workflow rejected: Cyclic dependency detected at agent '{agent_id}'")
                return False
            seen.add(agent_id)

        # 3. Recursion Depth (Assuming nested workflows report depth)
        # For now, we validate the static chain.
        
        logger.info(f"Workflow validated: {' -> '.join(workflow_chain)}")
        return True

    def is_recursion_safe(self, current_depth: int) -> bool:
        """
        Checks if the current recursion depth is safe for further delegation.
        """
        if current_depth >= self.MAX_RECURSION_DEPTH:
            logger.error(f"Recursion rejected: Current depth {current_depth} reaches limit {self.MAX_RECURSION_DEPTH}")
            return False
        return True

if __name__ == "__main__":
    validator = DAG_VALIDATOR()
    
    # Valid chain
    print(f"Valid chain: {validator.validate_workflow(['planner', 'code-architect', 'code-reviewer'])}")
    
    # Cyclic chain
    print(f"Cyclic chain: {validator.validate_workflow(['planner', 'architect', 'planner'])}")
    
    # Too long
    print(f"Too long: {validator.validate_workflow(['a', 'b', 'c', 'd', 'e', 'f'])}")
