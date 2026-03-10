# Orchestrate 커맨드

복잡한 작업을 위한 순차적 에이전트 워크플로우입니다.

## 사용법

`/orchestrate [workflow-type] [task-description]`

## 워크플로우 유형

### feature
전체 기능 구현 워크플로우:
```
planner -> tdd-guide -> code-reviewer -> security-reviewer
```

### bugfix
버그 조사 및 수정 워크플로우:
```
planner -> tdd-guide -> code-reviewer
```

### refactor
안전한 리팩토링 워크플로우:
```
architect -> code-reviewer -> tdd-guide
```

### security
보안 중심 리뷰:
```
security-reviewer -> code-reviewer -> architect
```

## 실행 패턴

워크플로우의 각 에이전트에 대해:

1. 이전 에이전트의 컨텍스트로 **에이전트 호출**
2. 구조화된 핸드오프 문서로 **출력 수집**
3. 체인의 **다음 에이전트에 전달**
4. **결과를 종합**하여 최종 보고서 작성

## 인자

$ARGUMENTS:
- `feature <description>` - 전체 기능 워크플로우
- `bugfix <description>` - 버그 수정 워크플로우
- `refactor <description>` - 리팩토링 워크플로우
- `security <description>` - 보안 리뷰 워크플로우
- `custom <agents> <description>` - 사용자 정의 에이전트 순서

## 팁

1. 복잡한 기능에는 **planner부터 시작**
2. merge 전에는 **항상 code-reviewer 포함**
3. 인증/결제/개인정보에는 **security-reviewer 사용**
4. **핸드오프는 간결하게** - 다음 에이전트에 필요한 것에 집중
5. 필요하면 에이전트 사이에 **검증 실행**
