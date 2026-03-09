import { Suspense } from 'react';
import SignupClient from './signup-client';

export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupClient />
    </Suspense>
  );
}
