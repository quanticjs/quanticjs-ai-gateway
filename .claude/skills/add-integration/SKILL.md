# Add AI Provider Integration

## When to Use
When adding a new AI backend provider (e.g., OpenAI, Gemini, local model server).

## Steps
1. **Create provider class** in `src/<module>/services/<Provider>.provider.ts`:
   ```typescript
   @Injectable()
   export class NewProvider implements AiProvider {
     readonly name = 'new-provider';
     private readonly breaker;

     constructor(
       private readonly config: ConfigService,
       @InjectPinoLogger(NewProvider.name) private readonly logger: PinoLogger,
       private readonly metrics: GenerateMetrics,
     ) {
       this.breaker = createCircuitBreaker({
         maxRetries: 2,
         consecutiveFailures: 5,
         halfOpenAfterMs: 30_000,
         onStateChange: (state) =>
           this.metrics.circuitBreakerState.set({ provider: 'new-provider' }, BREAKER_STATE[state] ?? 0),
       });
     }

     async generate(request: AiGenerateRequest): Promise<AiGenerateResponse> {
       return this.breaker.execute(() => this.callApi(request));
     }
   }
   ```
2. **Add to module provider factory** — update the `useFactory` for `AI_PROVIDER`
3. **Add environment variables** — API keys, URLs, model defaults
4. **Add timeout** — `AbortController` on all outbound HTTP calls

## Rules
- NEVER hardcode API keys — always `ConfigService.get()`
- Circuit breaker on ALL external HTTP calls (MANDATORY)
- Each provider gets its own circuit breaker
- 4xx responses are never retried
- Record metrics: duration, tokens, cost, circuit breaker state
- Provider is the ONLY class that knows the external API
