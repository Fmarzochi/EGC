# 테스트 커버리지

테스트 커버리지를 분석하고, 갭을 식별하며, 80% 이상 커버리지 달성을 위해 누락된 테스트를 생성합니다.

## 1단계: 테스트 프레임워크 감지

| 지표 | 커버리지 커맨드 |
|------|----------------|
| `jest.config.*` 또는 `package.json` jest | `npx jest --coverage --coverageReporters=json-summary` |
| `vitest.config.*` | `npx vitest run --coverage` |
| `pytest.ini` / `pyproject.toml` pytest | `pytest --cov=src --cov-report=json` |
| `Cargo.toml` | `cargo llvm-cov --json` |
| `go.mod` | `go test -coverprofile=coverage.out ./...` |

## 2단계: 커버리지 보고서 분석

1. 커버리지 커맨드 실행
2. 출력 파싱 (JSON 요약 또는 터미널 출력)
3. **80% 미만인 파일**을 최저순으로 정렬하여 목록화
4. 각 미달 파일에서 미테스트 함수, 누락된 분기 커버리지, 데드 코드 식별

## 3단계: 누락된 테스트 생성

우선순위에 따라 테스트 생성:

1. **Happy path** — 유효한 입력의 핵심 기능
2. **에러 처리** — 잘못된 입력, 누락된 데이터, 네트워크 실패
3. **엣지 케이스** — 빈 배열, null/undefined, 경계값 (0, -1, MAX_INT)
4. **분기 커버리지** — 각 if/else, switch case, 삼항 연산자

## 4단계: 검증

1. 전체 테스트 실행 — 모든 테스트 통과 확인
2. 커버리지 재실행 — 개선 확인
3. 여전히 80% 미만이면 나머지 갭에 대해 3단계 반복

## 집중 영역

- 복잡한 분기가 있는 함수 (높은 순환 복잡도)
- 에러 핸들러와 catch 블록
- 코드베이스 전반에서 사용되는 유틸리티 함수
- API 엔드포인트 핸들러 (요청 → 응답 흐름)
