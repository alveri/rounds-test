import { Link, Route, Routes } from 'react-router';
import { CompetitorList } from './pages/CompetitorList';
import { CompetitorTimeline } from './pages/CompetitorTimeline';

export function App() {
  return (
    <main>
      <h1>
        <Link to="/" className="brand">
          CompetitorPulse
        </Link>
      </h1>
      <Routes>
        <Route path="/" element={<CompetitorList />} />
        <Route path="/competitors/:id" element={<CompetitorTimeline />} />
        <Route path="*" element={<p>Page not found.</p>} />
      </Routes>
    </main>
  );
}
