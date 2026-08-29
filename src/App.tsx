import { Route, Routes } from "react-router-dom";
import Projects from "./screens/Projects";
import Editor from "./screens/Editor";
import Settings from "./screens/Settings";

export default function App() {
  return (
    <div className="app">
      <Routes>
        <Route path="/" element={<Projects />} />
        <Route path="/p/:id" element={<Editor />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </div>
  );
}
