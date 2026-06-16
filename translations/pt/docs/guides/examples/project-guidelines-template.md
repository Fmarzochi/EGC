# Template de Diretrizes de Projeto

Este e um template de skill especifico de projeto que foi anteriormente publicado como uma skill ativa do egc.

Agora vive em `docs/examples/` porque e material de referencia, nao uma skill reutilizavel entre projetos.

Este e um exemplo de skill especifica de projeto. Use como template para seus proprios projetos.

Baseado em uma aplicacao real de producao: [Zenith](https://zenith.chat) - Plataforma de descoberta de clientes com IA.

## Quando Usar

Referencie esta skill quando trabalhar no projeto especifico para o qual foi projetada. Skills de projeto contem:
- Visao geral da arquitetura
- Estrutura de arquivos
- Padroes de codigo
- Requisitos de teste
- Fluxo de trabalho de deploy

---

## Visao Geral da Arquitetura

**Stack Tecnologica:**
- **Frontend**: Next.js 15 (App Router), TypeScript, React
- **Backend**: FastAPI (Python), modelos Pydantic
- **Banco de Dados**: Supabase (PostgreSQL)
- **IA**: API Gemini com chamada de ferramentas e saida estruturada
- **Deploy**: Google Cloud Run
- **Testes**: Playwright (E2E), pytest (backend), React Testing Library

**Servicos:**
```
+---------------------------------------------------------+
|                         Frontend                        |
|  Next.js 15 + TypeScript + TailwindCSS                  |
|  Deploy: Vercel / Cloud Run                             |
+---------------------------------------------------------+
                              |
                              v
+---------------------------------------------------------+
|                         Backend                         |
|  FastAPI + Python 3.11 + Pydantic                       |
|  Deploy: Cloud Run                                      |
+---------------------------------------------------------+
                              |
              +---------------+---------------+
              v               v               v
        +----------+   +----------+   +----------+
        | Supabase |   |  Gemini  |   |  Redis   |
        | Database |   |   API    |   |  Cache   |
        +----------+   +----------+   +----------+
```

---

## Estrutura de Arquivos

```
project/
+-- frontend/
|   +-- src/
|       +-- app/              # Paginas do app router do Next.js
|       |   +-- api/          # Rotas de API
|       |   +-- (auth)/       # Rotas protegidas por autenticacao
|       |   +-- workspace/    # Workspace principal da aplicacao
|       +-- components/       # Componentes React
|       |   +-- ui/           # Componentes base de UI
|       |   +-- forms/        # Componentes de formulario
|       |   +-- layouts/      # Componentes de layout
|       +-- hooks/            # Custom React hooks
|       +-- lib/              # Utilitarios
|       +-- types/            # Definicoes TypeScript
|       +-- config/           # Configuracao
|
+-- backend/
|   +-- routers/              # Handlers de rota FastAPI
|   +-- models.py             # Modelos Pydantic
|   +-- main.py               # Entrypoint FastAPI
|   +-- auth_system.py        # Autenticacao
|   +-- database.py           # Operacoes de banco de dados
|   +-- services/             # Logica de negocio
|   +-- tests/                # Testes pytest
|
+-- deploy/                   # Configuracoes de deploy
+-- docs/                     # Documentacao
+-- scripts/                  # Scripts utilitarios
```

---

## Padroes de Codigo

### Formato de Resposta de API (FastAPI)

```python
from pydantic import BaseModel
from typing import Generic, TypeVar, Optional

T = TypeVar('T')

class ApiResponse(BaseModel, Generic[T]):
    success: bool
    data: Optional[T] = None
    error: Optional[str] = None

    @classmethod
    def ok(cls, data: T) -> "ApiResponse[T]":
        return cls(success=True, data=data)

    @classmethod
    def fail(cls, error: str) -> "ApiResponse[T]":
        return cls(success=False, error=error)
```

### Chamadas de API no Frontend (TypeScript)

```typescript
interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
}

async function fetchApi<T>(
  endpoint: string,
  options?: RequestInit
): Promise<ApiResponse<T>> {
  try {
    const response = await fetch(`/api${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    })

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` }
    }

    return await response.json()
  } catch (error) {
    return { success: false, error: String(error) }
  }
}
```

### Integracao com IA Gemini (Saida Estruturada)

```python
from anthropic import Anthropic
from pydantic import BaseModel

class AnalysisResult(BaseModel):
    summary: str
    key_points: list[str]
    confidence: float

async def analyze_with_gemini(content: str) -> AnalysisResult:
    client = Anthropic()

    response = client.messages.create(
        model="gemini-sonnet-4-5-20250514",
        max_tokens=1024,
        messages=[{"role": "user", "content": content}],
        tools=[{
            "name": "provide_analysis",
            "description": "Provide structured analysis",
            "input_schema": AnalysisResult.model_json_schema()
        }],
        tool_choice={"type": "tool", "name": "provide_analysis"}
    )

    tool_use = next(
        block for block in response.content
        if block.type == "tool_use"
    )

    return AnalysisResult(**tool_use.input)
```

### Custom Hooks (React)

```typescript
import { useState, useCallback } from 'react'

interface UseApiState<T> {
  data: T | null
  loading: boolean
  error: string | null
}

export function useApi<T>(
  fetchFn: () => Promise<ApiResponse<T>>
) {
  const [state, setState] = useState<UseApiState<T>>({
    data: null,
    loading: false,
    error: null,
  })

  const execute = useCallback(async () => {
    setState(prev => ({ ...prev, loading: true, error: null }))

    const result = await fetchFn()

    if (result.success) {
      setState({ data: result.data!, loading: false, error: null })
    } else {
      setState({ data: null, loading: false, error: result.error! })
    }
  }, [fetchFn])

  return { ...state, execute }
}
```

---

## Requisitos de Teste

### Backend (pytest)

```bash
# Executar todos os testes
poetry run pytest tests/

# Executar com cobertura
poetry run pytest tests/ --cov=. --cov-report=html

# Executar arquivo de teste especifico
poetry run pytest tests/test_auth.py -v
```

**Estrutura de teste:**
```python
import pytest
from httpx import AsyncClient
from main import app

@pytest.fixture
async def client():
    async with AsyncClient(app=app, base_url="http://test") as ac:
        yield ac

@pytest.mark.asyncio
async def test_health_check(client: AsyncClient):
    response = await client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "healthy"
```

### Frontend (React Testing Library)

```bash
# Executar testes
npm run test

# Executar com cobertura
npm run test -- --coverage

# Executar testes E2E
npm run test:e2e
```

**Estrutura de teste:**
```typescript
import { render, screen, fireEvent } from '@testing-library/react'
import { WorkspacePanel } from './WorkspacePanel'

describe('WorkspacePanel', () => {
  it('renderiza o workspace corretamente', () => {
    render(<WorkspacePanel />)
    expect(screen.getByRole('main')).toBeInTheDocument()
  })

  it('trata a criacao de sessao', async () => {
    render(<WorkspacePanel />)
    fireEvent.click(screen.getByText('Nova Sessao'))
    expect(await screen.findByText('Sessao criada')).toBeInTheDocument()
  })
})
```

---

## Fluxo de Trabalho de Deploy

### Checklist Pre-Deploy

- [ ] Todos os testes passando localmente
- [ ] `npm run build` bem-sucedido (frontend)
- [ ] `poetry run pytest` aprovado (backend)
- [ ] Nenhum segredo hardcoded
- [ ] Variaveis de ambiente documentadas
- [ ] Migracoes de banco de dados prontas

### Comandos de Deploy

```bash
# Build e deploy do frontend
cd frontend && npm run build
gcloud run deploy frontend --source .

# Build e deploy do backend
cd backend
gcloud run deploy backend --source .
```

### Variaveis de Ambiente

```bash
# Frontend (.env.local)
NEXT_PUBLIC_API_URL=https://api.example.com
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...

# Backend (.env)
DATABASE_URL=postgresql://...
ANTHROPIC_API_KEY=sk-ant-...
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_KEY=eyJ...
```

---

## Regras Criticas

1. **Sem emojis** em codigo, comentarios ou documentacao
2. **Imutabilidade** - nunca mute objetos ou arrays
3. **TDD** - escreva testes antes da implementacao
4. **80% de cobertura** minimo
5. **Muitos arquivos pequenos** - 200 a 400 linhas tipico, 800 maximo
6. **Sem console.log** em codigo de producao
7. **Tratamento adequado de erros** com try/catch
8. **Validacao de entrada** com Pydantic/Zod

---

## Skills Relacionadas

- `coding-standards.md` - Boas praticas gerais de codificacao
- `backend-patterns.md` - Padroes de API e banco de dados
- `frontend-patterns.md` - Padroes React e Next.js
- `tdd-workflow/` - Metodologia de desenvolvimento orientado a testes
