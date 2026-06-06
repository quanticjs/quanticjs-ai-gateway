# Add API Endpoint

## Steps
1. **Create handler** via `/add-handler`
2. **Create DTO** with class-validator + @ApiProperty decorators in `dtos/`
3. **Create response DTO** (typed, never raw objects)
4. **Add thin controller method:**
   ```typescript
   @Post('sync')
   @HttpCode(200)
   @ApiOperation({ summary: 'Generate AI response (synchronous)' })
   @ApiResponse({ status: 200, description: 'AI response generated' })
   @ApiResponse({ status: 400, description: 'Invalid request' })
   async generateSync(@Body() dto: GenerateRequestDto) {
     return this.commandBus.execute(
       new GenerateSyncCommand(dto.systemPrompt, dto.userPrompt, ...),
     );
   }
   ```
5. **Register** handler in module providers

## Rules
- Controller ONLY parses request → dispatches to bus → returns
- No services or repositories in controllers — CommandBus/QueryBus only
- Every endpoint needs @ApiOperation + @ApiResponse decorators
- Every DTO needs class-validator decorators + @ApiProperty
