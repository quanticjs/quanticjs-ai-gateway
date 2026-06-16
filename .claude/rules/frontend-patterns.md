---
globs: "client/src/**/*.{ts,tsx}"
---

# Frontend Patterns

## State Management — Decision Tree

| State type | Tool | When |
|---|---|---|
| **Server/remote data** | `useApiQuery` / `useApiMutation` (`@quanticjs/react-query`) | Data from API |
| **URL-derived state** | `useSearchParams` (React Router) | Filters, tabs, pagination — anything bookmarkable |
| **Local UI state** | `useState` | Open/closed, hover, animation — never leaves the component |
| **Shared client state** | Zustand store | Client-only state needed by 2+ unrelated components |
| **Form state** | `useForm` (`@quanticjs/react-forms`) + Zod | Multi-field forms with validation + automatic server error mapping |

### Data Fetching — `@quanticjs/react-query` Hooks

Use `useApiQuery` and `useApiMutation` from `@quanticjs/react-query` for ALL API calls. These wrap TanStack Query with automatic client injection and typed `ApiError` handling — do NOT use raw `useQuery`/`useMutation` from `@tanstack/react-query`.

```typescript
import { useApiQuery, useApiMutation, usePaginatedQuery } from '@quanticjs/react-query';

// Simple query — client is auto-injected
const { data, isLoading } = useApiQuery<Item>(
  ['items', id],
  (client) => client.get(`/items/${id}`),
);

// Mutation with cache invalidation
const mutation = useApiMutation<Item, CreateItemDto>(
  (client, dto) => client.post('/items', dto),
  { invalidates: [['items']] },
);

// Paginated query with page management
const { data, page, totalPages, nextPage, prevPage, hasNextPage } = usePaginatedQuery<Item>(
  ['items'],
  (client, { page, limit }) => client.get(`/items?page=${page}&limit=${limit}`),
);
```

Same `queryKey` in multiple components = one network request (auto-dedup).

### Zustand — Selectors Only

```typescript
// ✅ CORRECT — only re-renders when radius changes
const radius = useFilterStore((s) => s.radius);

// ❌ WRONG — re-renders on ANY store change
const { radius, category } = useFilterStore();
```

### URL State

```typescript
const [searchParams, setSearchParams] = useSearchParams();
const tab = searchParams.get('tab') ?? 'discover';
```

## API Error Handling

| ApiError property | HTTP status | UI behavior |
|---|---|---|
| `isValidation` | 400, 422 | Field errors on form, or detailed toast |
| `isNotFound` | 404 | Navigate to "not found" page or show empty state |
| `isForbidden` | 403 | Show "access denied" — do NOT retry |
| `isUnauthorized` | 401 | Automatic — refresh token → retry → redirect to login |
| `isConflict` | 409 | Show "already exists" or "was modified" — suggest refresh |
| `isRateLimited` | 429 | Show "try again later" with `retryAfter` value |
| 5xx | 500, 502, 503 | Generic "Something went wrong" toast — **never** show `error.detail` (may contain stack traces) |

Always include `error.correlationId` in error UI so users can report it to support.

**Forms — automatic server-to-field mapping:** `useForm` (`@quanticjs/react-forms`) + Zod auto-maps server validation errors to fields via `ApiError.fieldErrors` — server `{ errors: { email: "already taken" } }` → `errors.email` auto-set; non-field errors → `errors._root`. Never map manually.

**Non-form mutations — MANDATORY `onError`:**

```typescript
const toast = useToast(); // @quanticjs/react-ui
const mutation = useApiMutation<void, string>(
  (client, id) => client.delete(`/items/${id}`),
  {
    invalidates: [['items']],
    onError: (error) => {
      toast.error(error); // ApiError-aware — extracts title + detail
    },
  },
);
```

## App Root Provider Stack (MANDATORY)

The app root must wrap providers in this exact order. Outer providers are available to inner ones. All providers come from `@quanticjs/*` packages — do NOT create local equivalents.

```tsx
<ErrorBoundary fallback={<ErrorFallback />} onError={Sentry.captureException}>
  <QuanticProvider client={apiClient}>
    <QuanticQueryProvider>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QuanticQueryProvider>
  </QuanticProvider>
</ErrorBoundary>
```

**Why this order:**
- `ErrorBoundary` (`@quanticjs/react-ui`) outermost — catches errors even if inner providers fail to mount, reports to Sentry via `onError`
- `QuanticProvider` (`@quanticjs/react-core`) — API client context, needed by everything below
- `QuanticQueryProvider` (`@quanticjs/react-query`) — TanStack Query with smart defaults (no 4xx retry, 30s stale time)
- `ToastProvider` (`@quanticjs/react-ui`) — toast context, available to all pages and components
- `RouterProvider` innermost — pages and components

## Authentication & Authorization

Auth is server-driven. Use framework hooks and components exclusively.

```typescript
import { useAuth, useLogout, usePermissions, Can, AuthGuard, PermissionGuard } from '@quanticjs/react-core';

// Session — fetches /auth/me with staleTime: Infinity
const { session, isLoading, isAuthenticated, isAdmin } = useAuth();

// Permissions — uses resource:action format from session.permissions
const { can, canAny, hasRole } = usePermissions();
if (can('brd:edit')) { /* ... */ }

// Declarative rendering
<Can permission="cr:review">
  <StrategyAssessmentSection />
</Can>

// Route guards
<AuthGuard loading={<PageSkeleton />}>
  <ProtectedRoute />
</AuthGuard>

<PermissionGuard permission="reports.view" fallbackUrl="/dashboard">
  <ReportsPage />
</PermissionGuard>

// Logout
const { logout, isLoggingOut } = useLogout();
```

**Auth state is server state** — it comes from `/auth/me` and lives in TanStack Query cache with `staleTime: Infinity`. It is NOT stored in localStorage, Zustand, or local state.

## UI Components — Framework First, Then shadcn/ui

**First** check if the component exists in `@quanticjs/react-ui` (ErrorBoundary, Skeleton, Spinner, Dialog, EmptyState, ToastProvider, DataTable, Pagination, QueryErrorPanel, ThemeToggle) or one of the domain packages — `@quanticjs/react-layouts` for the app shell (sidebar/top bar/user menu), `@quanticjs/react-notifications` for the notification bell/panel. Use it.

Shared utilities live there too: `formatDate`/`formatDateTime`/`formatRelativeTime`/`formatDuration`/`formatBytes`/`setDefaultLocale` and `useDebounce` come from `@quanticjs/react-ui` — never write local copies.

**Only if the component does NOT exist in the framework**, use shadcn/ui primitives from `@/components/ui` (Button, Avatar, Badge, DropdownMenu, Tooltip, Separator, Sheet, etc.). Compose into feature components — never modify primitives directly. All components must accept `className` for extension and forward refs.

## Component Library Requirements

- Every shared component must have a Storybook entry showing variants, states (loading, disabled, error), and usage
- Accessibility enforced in CI via axe-core at WCAG 2.2 Level AA — violations block PR merges

## Design Tokens & Dark Mode

No hardcoded hex values in application code. All visual values come from design tokens/CSS variables via `@quanticjs/tailwind-preset`:

```css
@import "tailwindcss";
@import "@quanticjs/tailwind-preset/theme.css";

/* Tailwind v4 does not scan node_modules — register every @quanticjs
   package the app uses that renders UI, or its token classes are dropped */
@source "../node_modules/@quanticjs/react-ui/dist";
@source "../node_modules/@quanticjs/react-layouts/dist";
/* …one line per installed @quanticjs UI package */
```

Use semantic token classes: `bg-primary`, `text-foreground`, `border-border` — never `bg-blue-500`, `text-gray-700`. Dark mode is class-based (`.dark` on `<html>`), zero-runtime CSS switching via `hsl(var(--background))`, `hsl(var(--primary))`, etc.

The same applies beyond colors (preset ≥ 8 — see "Surfaces, Motion, Elevation & Stacking" in `frontend-framework-ref.md`):

- **Elevation:** `shadow-surface` (cards/tables), `shadow-raised` (popovers/dropdowns/toasts), `shadow-overlay` (dialogs/drawers) — never literal `shadow-md/lg/xl`.
- **Stacking:** the `z-(--z-*)` scale (`sticky` 10 < `drawer` 40 < `modal` 50 < `popover` 60 < `toast` 70 < `skip-link` 100) — never magic `z-10`/`z-50`/`z-[60]`. To stack relative to framework UI, reference the scale.
- **Motion:** the preset's `--duration-*`/`--ease-*` tokens and named `animate-overlay|pop|toast|drawer-in/out` animations — never invented durations or one-off keyframes for overlay choreography.

For programmatic access (charts, canvas):

```typescript
import { light, dark, motion, shadows, zIndex } from '@quanticjs/tailwind-preset';
light.primary;         // '237 71% 38%'
motion.durations.base; // '180ms'
zIndex.toast;          // 70
```

### No Custom Theme Builds

The preset's `theme.css` is the ONLY theme definition in a consumer app — never define design tokens locally (no `:root`/`.dark` token blocks even "temporarily", no `tailwind.config.{ts,js}` theme mapping — Tailwind v4 consumer apps are CSS-first: `@import` + `@source` only — and no second theming mechanism like CSS-in-JS ThemeProvider or `[data-theme]`; the preset's `.dark` class contract is the only one). Why: a local copy silently freezes the app on an old brand and misses tokens added later (`success`, `warning`, `chart-*`) — framework components emitting those classes render unstyled.

If an app needs a token the preset lacks, add it to `quanticjs-ui/packages/tailwind-preset` (PR there), never locally — brand changes ship as preset releases. App CSS may *consume* tokens (`color: hsl(var(--muted-foreground))` is fine); it may never *define* them.

## TypeScript Strict Mode

All code uses `strict: true`, `noUncheckedIndexedAccess: true`. No `any`, no `@ts-ignore`.

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

## Browser Type Safety

```typescript
// ❌ WRONG — requires @types/node
const timer: NodeJS.Timeout = setTimeout(() => {}, 1000);

// ✅ CORRECT
const timer: ReturnType<typeof setTimeout> = setTimeout(() => {}, 1000);
```

## Page Components

All page components are lazy-loaded with `React.lazy()` and wrapped in `<Suspense>`.

## Component Architecture

### Feature-Based Folder Structure

```
src/
  app/              — Routes, providers, app shell
  assets/           — Global static files
  components/       — Shared UI components (used across features)
  config/           — Environment variables, global config
  features/         — Primary organization axis
    auth/
      components/
      hooks/
      api/
      types/
    dashboard/
      components/
      hooks/
      api/
      types/
  hooks/            — Shared hooks (used by 2+ features)
  lib/              — Pre-configured library instances
  types/            — Shared TypeScript types
  utils/            — Shared utility functions
```

Not every feature needs every subdirectory. A small feature may be a single file.

### Import Rules — Unidirectional Flow

```
shared (components/, hooks/, utils/, types/, lib/)
  ↓
features/*
  ↓
app/
```

- **Features never import from other features.** Shared logic is promoted to the shared layer.
- **Features never import from `app/`.**
- **Shared code never imports from features.**
- **Application code never deep-imports from packages.** Import from the package root.

### File Naming

| Item | Convention | Example |
|---|---|---|
| Component files | kebab-case | `item-card.tsx` |
| Component exports | PascalCase | `export function ItemCard()` |
| Hook files | kebab-case with `use-` prefix | `use-item-filters.ts` |
| Hook exports | camelCase with `use` prefix | `export function useItemFilters()` |
| Utility / type files | kebab-case | `format-date.ts`, `types.ts` |
| Test files | Same name + `.test` suffix | `item-card.test.tsx` |
| Feature folders | singular kebab-case | `features/item` |
| Grouping folders | plural | `features/`, `components/`, `hooks/` |

### Co-Location

- **Tests** next to source: `item-card.test.tsx` alongside `item-card.tsx`. Exception: E2E tests in `e2e-ui/`.
- **Types** in the feature: `features/item/types.ts`. Only truly shared types in top-level `types/`.
- **Promotion rule:** Start co-located. Promote to shared layer when a second consumer needs it.

### Barrel Exports — Discouraged for App Code

Barrel exports (`index.ts` re-exporting everything) impair tree-shaking and slow test startup. Use direct imports. Exception: `@quanticjs/*` packages use barrel exports for their public API — this is correct for libraries.

### Component Composition & Sizing

Use the simplest pattern: children prop → custom hooks → compound components → render props → HOCs (last resort).

**~200 lines is a reasonable ceiling.** Split by responsibility, not line count. Split when business logic mixes with presentation (extract to a hook), a subsection is reusable elsewhere, or JSX has 3+ levels of conditional nesting.

### Component API Design

```typescript
interface ButtonProps extends React.ComponentPropsWithRef<'button'> {
  variant: 'primary' | 'secondary' | 'destructive';
  size?: 'sm' | 'md' | 'lg';
}

// Standard function declaration — NOT React.FC
function Button({ variant, size = 'md', ...props }: ButtonProps) {
  return <button className={cn(variants({ variant, size }))} {...props} />;
}
```

- Do not use `React.FC`. Use function declarations with explicit props.
- Type children as `React.ReactNode` when needed.
- All shared components accept `className` for extension.

### Custom Hooks

Extract when stateful logic is reused across 2+ components, or when a component mixes business logic with rendering. Test through a real component first; use `renderHook` for reusable hooks needing isolation.

## Accessibility — WCAG 2.2 AA

- **Build interactive components on headless primitives** (Base UI, React Aria). No custom `<div onClick>` buttons.
- **Semantic HTML first** — `<button>`, `<nav>`, `<main>`, `<dialog>` — not `<div role="button">`.
- **Focus indicators visible** with 3:1 contrast. Never `outline: none` without a replacement.
- **Focus trapping in modals** — on open: focus first element; while open: trap Tab; on Escape: close; on close: return focus to trigger. (Handled by `Dialog` from `@quanticjs/react-ui`.)
- **Animated overlay exits (framework ≥ 8)** — app overlays that animate out must stay mounted until the exit animation ends: use `useExitAnimation` from `@quanticjs/react-ui` (`data-state` + `onAnimationEnd` + safety-timeout contract), don't hand-roll unmount delays. Key the focus trap off the `open` prop (released on close start), never off the hook's `mounted` — keyboard users must not be trapped during the exit.
- **Touch targets at least 24×24 CSS pixels** (WCAG 2.5.8 AA).
- **`aria-live` regions always mounted** — change content, don't conditionally render the container.
- **Keep ARIA state in sync with React state** — `aria-expanded={isOpen}`, not `aria-expanded="false"`.

## Performance

- **React Compiler** handles automatic memoization — do NOT add new `React.memo`, `useMemo`, `useCallback` without profiling evidence.
- **Route-level code splitting** — every route uses `React.lazy()` + `<Suspense>`.
- **Split heavy components** — modals, drawers, chart libraries, rich text editors.
- **Virtualize lists above 200 complex items** — use `@tanstack/react-virtual` or `react-virtuoso`.
- **No barrel imports for large libraries** — use direct/deep imports.
- **New dependencies over 20KB gzipped require justification** in the PR.
- **Images below the fold use `loading="lazy"`**. LCP images load eagerly with `fetchpriority="high"`.

## Third-Party Library Integration

When a third-party library lacks TypeScript types, isolate all `any` casts behind a single typed adapter module. Do not scatter untyped casts across components.

```typescript
// example: bpmn-types.ts — centralized typed access for bpmn-js
import type Modeler from 'bpmn-js/lib/Modeler';
import type Viewer from 'bpmn-js/lib/Viewer';

interface BpmnCanvas { zoom(level: number | 'fit-viewport'): number; addMarker(id: string, cls: string): void; removeMarker(id: string, cls: string): void; scrollToElement(el: BpmnElement): void; }
interface BpmnCommandStack { canUndo(): boolean; canRedo(): boolean; undo(): void; redo(): void; }
interface BpmnElementRegistry { get(id: string): BpmnElement | undefined; }
interface BpmnModeling { updateProperties(element: BpmnElement, props: Record<string, unknown>): void; }
interface BpmnSelection { select(element: BpmnElement): void; }
interface BpmnOverlays { add(id: string, type: string, overlay: unknown): void; remove(filter: Record<string, unknown>): void; }
interface BpmnModdle { create(type: string, props?: Record<string, unknown>): unknown; }
export interface BpmnElement { id: string; type: string; businessObject?: Record<string, unknown>; width?: number; height?: number; source?: BpmnElement; [key: string]: unknown; }

type ServiceMap = { canvas: BpmnCanvas; commandStack: BpmnCommandStack; elementRegistry: BpmnElementRegistry; modeling: BpmnModeling; selection: BpmnSelection; overlays: BpmnOverlays; moddle: BpmnModdle; };

export function getService<K extends keyof ServiceMap>(modeler: Modeler | Viewer, name: K): ServiceMap[K] {
  return (modeler as Record<string, unknown>).get(name) as ServiceMap[K];
}
```

## NEVER

### Framework & State
- **NEVER** fetch data with `useEffect` + `useState` — use `useApiQuery` from `@quanticjs/react-query`
- **NEVER** use raw `useQuery`/`useMutation` from `@tanstack/react-query` — use `useApiQuery`/`useApiMutation` from `@quanticjs/react-query` (auto-injects client, types errors as `ApiError`)
- **NEVER** create a local `QueryClientProvider` or `QueryClient` — use `QuanticQueryProvider` from `@quanticjs/react-query`
- **NEVER** create local implementations of components that exist in `@quanticjs/react-ui` (`ErrorBoundary`, `Skeleton`, `Spinner`, `ToastProvider`, `EmptyState`, `Dialog`, `DataTable`, `Pagination`, `QueryErrorPanel`, `ThemeToggle`, `cn`) — import from the framework package
- **NEVER** write local date/duration/byte formatters or `timeAgo()`/`useDebounce` copies — use `formatDate`/`formatDateTime`/`formatRelativeTime`/`formatDuration`/`formatBytes`/`useDebounce` from `@quanticjs/react-ui` (locale via `setDefaultLocale` at bootstrap)
- **NEVER** hand-roll an app shell (sidebar + mobile drawer + top bar + user menu) — use `AppShell`/`Sidebar`/`TopBar`/`UserMenu` from `@quanticjs/react-layouts`
- **NEVER** hand-roll a notification bell/panel or `/notifications` fetch hooks — use `@quanticjs/react-notifications` (standard endpoint contract)
- **NEVER** run two writers of the `dark` class — when adopting `useTheme`/`ThemeToggle`, delete any local theme toggler
- **NEVER** create a local `useToast` hook or toast provider — use `ToastProvider` + `useToast` from `@quanticjs/react-ui`
- **NEVER** create a local API client with manual `createClient` boilerplate — use `createDefaultClient` from `@quanticjs/react-core` for BFF apps
- **NEVER** create a local `useAuth`, `useSession`, or session-fetching hook — use `useAuth` from `@quanticjs/react-core`
- **NEVER** create a local `usePermissions` hook or `Can` component — use `usePermissions` and `Can` from `@quanticjs/react-core`
- **NEVER** create a local `AuthGuard` or `PermissionGuard` — use the framework components from `@quanticjs/react-core`
- **NEVER** create a local logout handler — use `useLogout` from `@quanticjs/react-core`
- **NEVER** derive permissions from roles on the frontend — permissions come from the server `/auth/me` response
- **NEVER** store auth tokens in localStorage or sessionStorage — auth is httpOnly cookies via BFF
- **NEVER** create local error classes or `ProblemDetails`/`ValidationFieldError` types — use from `@quanticjs/react-core`
- **NEVER** create local interceptor functions — use `correlationId()` (and on native/mobile only, `bearerAuth()`) from `@quanticjs/react-core`; web is BFF and never attaches Authorization headers (`tenantId()` is removed in v7 — the server ignores `X-Tenant-ID` and the header fails CORS preflight)
- **NEVER** create a local `RequestInterceptor` type — import it from `@quanticjs/react-core`
- **NEVER** copy query data into `useState` — it creates a stale snapshot
- **NEVER** mirror URL params into `useState` — read from `useSearchParams` directly
- **NEVER** put server data in Zustand — use `useApiQuery`
- **NEVER** destructure entire Zustand store without selectors
- **NEVER** add Redux, MobX, Jotai, Recoil, or Valtio
- **NEVER** use `react-hook-form` directly — use `useForm` from `@quanticjs/react-forms` which adds automatic server error mapping
- **NEVER** manually map server validation errors to form fields — `useForm` does this automatically via `ApiError.fieldErrors`

### Error Handling
- **NEVER** parse API error responses manually — use `ApiError` properties (`detail`, `fieldErrors`, `correlationId`)
- **NEVER** show raw error messages to users in production — map `ApiError.status` to user-friendly messages
- **NEVER** show `error.detail` from 5xx responses — may contain stack traces; use generic message instead
- **NEVER** write `catch (e) { console.log(e) }` on mutations — swallowing errors silently is a bug
- **NEVER** omit `onError` on non-form mutations — every mutation failure must be visible to the user
- **PREFER** `<ErrorBoundary>` on page components — allows recovering a single page without resetting the entire app (the root boundary is the fallback)

### Architecture & Code Quality
- **NEVER** import across features — promote shared code to the shared layer
- **NEVER** deep-import from packages — use the public API only
- **NEVER** place tests in a separate `__tests__/` tree — co-locate next to source
- **NEVER** use `React.FC` — use function declarations with typed props
- **NEVER** prop-drill through components that don't use the prop
- **NEVER** use `console.log` in production code — use Sentry
- **NEVER** use `console.warn` or `console.error` in library packages — use Sentry or structured error reporting
- **NEVER** use `any` — use `unknown` and narrow
- **NEVER** use `@ts-ignore` — use `@ts-expect-error` with comment
- **NEVER** use `NodeJS.Timeout` or other Node.js types in frontend code
- **NEVER** scatter `(modeler as any).get(...)` across components — isolate all bpmn-js `any` casts in a single `bpmn-types.ts` adapter module
- **NEVER** export components from `@quanticjs/*` packages without `className` prop support

### Styling & Design
- **NEVER** hardcode hex colors or spacing values — use design tokens
- **NEVER** use raw Tailwind palette values (`bg-blue-500`, `text-gray-700`) — use semantic tokens (`bg-primary`, `text-foreground`)
- **NEVER** use inline `style={{ gap: '1rem' }}` — use Tailwind gap utilities (`gap-4`) or CSS variables
- **NEVER** build a custom theme — no local `:root`/`.dark` token definitions, no `tailwind.config.{ts,js}` theme mapping, no second theming mechanism; import `@quanticjs/tailwind-preset/theme.css` (see "No Custom Theme Builds")
- **NEVER** use literal `shadow-md/lg/xl` — use the elevation tiers `shadow-surface`/`shadow-raised`/`shadow-overlay` (preset ≥ 8)
- **NEVER** hardcode z-indices (`z-10`, `z-50`, `z-[60]`, `z-[9999]`) — use the `z-(--z-*)` stacking scale; toasts sit at 70, so "above everything" hacks break ordering
- **NEVER** invent animation durations/easings for overlay choreography — use the preset's `--duration-*`/`--ease-*` tokens and `animate-*` utilities, and `useExitAnimation` for exit-before-unmount

### Accessibility
- **NEVER** build custom interactive widgets from `<div>` elements without headless primitives
- **NEVER** use `outline: none` on interactive elements without a focus replacement
- **NEVER** use `tabindex` values greater than 0
- **NEVER** conditionally render `aria-live` containers — only change content

### Performance
- **NEVER** add `React.memo`/`useMemo`/`useCallback` without profiling — the React Compiler handles memoization
- **NEVER** render 200+ complex list items without virtualization
