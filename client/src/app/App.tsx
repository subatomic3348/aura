import { parseRoute, usePathname } from '../lib/router';
import { Landing } from '../ui/screens/Landing';
import { NotFoundPage, RoomPage } from './pages';

export function App() {
  const route = parseRoute(usePathname());

  switch (route.name) {
    case 'home':
      return <Landing />;
    case 'new':
      return <RoomPage key="new" rawCode={null} />;
    case 'room':
      // key: a different code means a different room.
      return <RoomPage key={route.code} rawCode={route.code} />;
    case 'not-found':
      return <NotFoundPage />;
  }
}
