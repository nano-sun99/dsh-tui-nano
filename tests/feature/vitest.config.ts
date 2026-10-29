import { defineConfig } from 'vitest/config'

// S02 的功能面测试：根配置只收 tests/unit（S01 拥有），这里单独收 tests/feature。
export default defineConfig({
  test: {
    include: ['tests/feature/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
  },
})
