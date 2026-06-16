---
globs: "client/src/**/*.{ts,tsx}, packages/**/*.{ts,tsx}"
---

# QuanticJS Framework — Usage Rules

All frontend code uses framework packages from `@quanticjs/*`. These are the canonical tools — do not introduce alternatives. **Before writing any client, error, UI, form, formatting, or i18n code, check the framework first.** The complete export catalog, options signatures, and version notes live in the `/framework-reference` skill — invoke it when you need to look up what a package provides.

## Client Setup

For BFF apps (all web projects), use the zero-config preset — it wires `baseUrl '/api'`, cookie credentials, `correlationId()`, CSRF, auth refresh on 401, and login redirect:

```typescript
import { createDefaultClient } from '@quanticjs/react-core';
export const apiClient = createDefaultClient();
```

- Extra interceptors go in `createDefaultClient({ interceptors: [...] })` — custom ones only.
- `bearerAuth(() => getToken())` is for **native/mobile clients only** — web is BFF: the browser never holds a token and never attaches Authorization headers.
- `tenantId()` is **removed in v7** — the server derives tenant from the verified JWT and ignores `X-Tenant-ID`; the header fails CORS preflight. Never send it.
- Custom interceptors use the `RequestInterceptor` type from `@quanticjs/react-core` — `(ctx) => ctx`.

## Data Fetching & Mutation Errors

- `useApiQuery` / `useApiMutation` from `@quanticjs/react-query` for all data fetching — never raw `useQuery`/`useMutation`. Use `useClient()` directly only outside query/mutation contexts (rare).
- **Every `useApiMutation` must have an `onError`** that toasts via the framework's `useToast()` (`ApiError`-aware). Server errors (`isServerError`) get a generic message + `correlationId` reference; other errors show `title`/`detail` + `correlationId`.
- Toasts come from `useToast()` (`@quanticjs/react-ui`, provided by `<ToastProvider>`). Error toasts always include `correlationId`.

## MANDATORY — Use Framework Exports, Never Local Versions

- `createClient`, `ApiClient`, `ClientConfig`, `AuthConfig`, `RequestOptions`, `RequestContext`, `RequestInterceptor` → from `@quanticjs/react-core`, not local client/type definitions
- `ApiError`, `isApiError`, `ErrorType`, `ProblemDetails`, `ValidationFieldError` → from `@quanticjs/react-core`, not local error classes or type definitions
- `correlationId`, `bearerAuth` (native only) → from `@quanticjs/react-core`, not local interceptor functions
- `QuanticProvider`, `useClient`, `QuanticProviderProps` → from `@quanticjs/react-core`, not local context/provider
- `ErrorBoundary` → from `@quanticjs/react-ui`, not a custom class component
- `Skeleton`, `Spinner` → from `@quanticjs/react-ui`, not local `@/components/ui/skeleton`
- `ToastProvider` + `useToast` → from `@quanticjs/react-ui`, not a local toast implementation
- `EmptyState` → from `@quanticjs/react-ui`, not a custom empty-state component
- `Dialog` → from `@quanticjs/react-ui`, not `@radix-ui/react-dialog` directly
- `Button` → from `@quanticjs/react-ui` (variants: primary/secondary/outline/ghost/destructive; sizes sm/md/lg/icon), not hand-rolled `<button>` styling
- `Card`/`CardHeader`/`CardTitle`/`CardContent` → from `@quanticjs/react-ui`, not local `rounded-xl border bg-card` divs
- `StatusBadge` → from `@quanticjs/react-ui` for ALL status pills/dots (dot appearance for table rows, solid for emphatic single statuses), not hand-rolled colored pills
- `DescriptionList`/`DescriptionItem` → from `@quanticjs/react-ui` for label/value detail and profile views
- `cn` → from `@quanticjs/react-ui`, not a local `clsx` + `tailwind-merge` wrapper
- `useApiQuery` / `useApiMutation` → from `@quanticjs/react-query`, not raw `useQuery` / `useMutation`
- `QuanticQueryProvider` → from `@quanticjs/react-query`, not a manual `QueryClientProvider`
- `formatDate`, `formatDateTime`, `formatRelativeTime`, `formatDuration`, `formatBytes`, `useDebounce` → from `@quanticjs/react-ui`, not local `format.ts`/`timeAgo()`/`durationLabel()`/`use-debounce.ts` copies
- `readCsrfCookie` → from `@quanticjs/react-core`, not manual `document.cookie` parsing for CSRF
- App shell (sidebar/top bar/user menu) → from `@quanticjs/react-layouts`, not a hand-rolled `AppLayout`/`Sidebar` per app
- Notification bell/panel/data hooks → from `@quanticjs/react-notifications`, not a hand-rolled `NotificationPanel` + fetch hooks
- `TranslationProvider`, `useLocale`, `useTranslations`, `resolveLabels` → from `@quanticjs/react-ui`, not a local i18n context or per-app label-threading; do NOT add `react-i18next`/ICU layers for framework component strings
- Form controls (`FormField`, `Input`, `Textarea`, `Select`, `Checkbox`, `Radio`, `RadioGroup`, `Switch`) → from `@quanticjs/react-ui` + `useForm`/`fieldError` from `@quanticjs/react-forms`, not hand-rolled inputs or label/error ARIA wiring

## Formatters & i18n — Hard Rules

- The shared formatters are `Intl`-based, locale-aware, and return `''` for null/undefined/invalid. Every local `function formatDate(...)` / `timeAgo()` / `useDebounce` copy in app code is a defect — import instead.
- `setDefaultLocale` is called ONCE at app bootstrap, before mounting. With `TranslationProvider`, `useLocale()` flows the locale into formatters reactively.
- Framework component strings resolve **explicit `labels` prop > provider catalog > English default** — pass translations via `TranslationProvider`, never fork components for copy changes.

## Layout, Theming & Motion — Hard Rules (framework ≥ 8)

- **Logical properties only:** use `start-*`, `ps-*`, `text-start`, `border-e` — never `left-*`/`pl-*`/`text-left`/`border-r`. RTL is attribute-driven (`dir="rtl"` on `<html>`); there is NO `DirectionProvider` — do not build one.
- **Semantic surfaces:** `bg-background`/`bg-card`/`bg-popover` — never hardcode `bg-white` or HSL values to imitate a surface.
- **Elevation:** `shadow-surface`/`shadow-raised`/`shadow-overlay` only. Literal `shadow-md/lg/xl` are FORBIDDEN in component code (guard test enforces it).
- **Stacking:** use the z-scale via `z-(--z-*)` utilities (`sticky` 10 < `drawer` 40 < `modal` 50 < `popover` 60 < `toast` 70 < `skip-link` 100). Never hardcode `z-10`/`z-50`/`z-[60]`.
- **Motion:** use the duration/easing tokens and named `animate-*` keyframes; never invent durations. Animated app components must carry `motion-reduce:` utilities.
- **Exit animations:** app overlays use `useExitAnimation` from `@quanticjs/react-ui` — do NOT hand-roll unmount-delay logic.
- **Upgrade order:** the tailwind preset must reach v8 before any 8.x component package (see `quanticjs-ui/docs/MIGRATION-8.md`).
- `ColumnDef.align` takes `'start' | 'end' | 'center'` — `'left'`/`'right'` are deprecated aliases; don't use them in new code.

## Forms — Hard Rules (≥ 8.0)

- `FormField` owns ids and ARIA wiring (`id`, `aria-describedby`, `aria-invalid`, `aria-required`, `role="alert"` errors) — one control per `FormField`; custom widgets join via `useFormField()`.
- Boolean fields use `form.registerCheckbox(name)` (reads `checked`); `register()` reads string values.
- Field errors flow through `fieldError(form, name)` into `FormField`'s `error` prop — never gate on `touched`/`errors` by hand. Root-level server errors (`errors._root`) render via `QueryErrorPanel` or an inline alert, not `FormField`.
- A rich combobox is NOT shipped yet — request it as a framework component rather than building one per app.

## Shared Component Contract

All exported components in shared packages MUST accept `className`, forward refs where applicable, use semantic token classes (no hardcoded hex/spacing), and never `console.log`/`console.warn` — use Sentry or structured error reporting.

## Standard Endpoint Contracts

- Notifications: `GET /notifications`, `GET /notifications/unread-count`, `POST /notifications/{id}/read`, `POST /notifications/read-all` — when the backend implements this, use `@quanticjs/react-notifications` wholesale.
- IAM audit pages (`@quanticjs/iam-audit-ui`) require the backend `@quanticjs/iam-audit` module; pages are named exports (`React.lazy()` with `.then(m => ({ default: m.PageName }))`).
- Files: wrap with `<FilesProvider apiBaseUrl="/api/files">`; custom upload UIs use `useFileUpload()`.

For everything else — full export tables, options, props, version-gated details — invoke the `/framework-reference` skill.
