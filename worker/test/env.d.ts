import type { D1Migration } from 'cloudflare:test'

import type { Bindings } from '../src/lib/env'

declare global {
  namespace Cloudflare {
    interface Env extends Bindings {
      TEST_MIGRATIONS: D1Migration[]
    }
    interface GlobalProps {
      mainModule: typeof import('../src/index')
    }
  }
}
