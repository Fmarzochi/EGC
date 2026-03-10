# Eval 커맨드

평가 기반 개발 워크플로우를 관리합니다.

## 사용법

`/eval [define|check|report|list] [feature-name]`

## 평가 정의

`/eval define feature-name`

새로운 평가 정의를 생성합니다:

1. `.claude/evals/feature-name.md`에 템플릿 생성
2. 사용자에게 구체적인 기준을 입력하도록 안내

## 평가 확인

`/eval check feature-name`

기능에 대한 평가를 실행합니다:

1. `.claude/evals/feature-name.md`에서 평가 정의 읽기
2. 각 기능 평가: 기준 검증 시도, PASS/FAIL 기록
3. 각 회귀 평가: 관련 테스트 실행, 기준선과 비교
4. 현재 상태 보고

## 평가 보고

`/eval report feature-name`

포괄적인 평가 보고서를 생성합니다.

## 평가 목록

`/eval list`

모든 평가 정의를 표시합니다.

## 인자

$ARGUMENTS:
- `define <name>` - 새 평가 정의 생성
- `check <name>` - 평가 실행 및 확인
- `report <name>` - 전체 보고서 생성
- `list` - 모든 평가 표시
- `clean` - 오래된 평가 로그 제거 (최근 10회 유지)
