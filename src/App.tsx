import { Route, Routes } from "react-router-dom";
import Projects from "./screens/Projects";
import Editor from "./screens/Editor";

export default function App() {
  return (
    <div className="app">
      <Routes>
        <Route path="/" element={<Projects />} />
        <Route path="/p/:id" element={<Editor />} />
      </Routes>
    </div>
  );
}
