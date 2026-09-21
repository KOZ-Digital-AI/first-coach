import { createRootRoute, Outlet } from '@tanstack/react-router';
import { useSlot } from '../lib/slots';

function RootLayout() {
  const headerExtras = useSlot('header');
  const rootExtras = useSlot('root');
  return (
    <>
      {headerExtras.length > 0 && (
        <header data-slot="header">
          {headerExtras.map((Extra, index) => (
            <Extra key={index} />
          ))}
        </header>
      )}
      <Outlet />
      {rootExtras.map((Extra, index) => (
        <Extra key={index} />
      ))}
    </>
  );
}

export const Route = createRootRoute({ component: RootLayout });
