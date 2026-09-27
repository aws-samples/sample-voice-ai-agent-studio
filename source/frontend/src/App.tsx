import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { WizardProvider } from './context/WizardContext';
import { AutoSaveProvider } from './context/AutoSaveContext';
import { FilterProvider } from './context/FilterContext';
import Layout from './components/Layout';
import Login from './pages/Login';
import OAuthCallback from './pages/OAuthCallback';

const Launch = lazy(() => import('./pages/Launch'));
const Overview = lazy(() => import('./pages/Overview'));
const Home = lazy(() => import('./pages/Home'));
const Voice1S = lazy(() => import('./pages/Voice1S'));
const PipelineSelection = lazy(() => import('./pages/PipelineSelection'));
const SpeechToSpeech = lazy(() => import('./pages/SpeechToSpeech'));
const CascadedSpeech = lazy(() => import('./pages/CascadedSpeech'));
const Agents = lazy(() => import('./pages/Agents'));
const PromptBuilder = lazy(() => import('./pages/PromptBuilder'));
const Summary = lazy(() => import('./pages/Summary'));
const POC = lazy(() => import('./pages/POC'));
const Demos = lazy(() => import('./pages/Demos'));
const AgentDetail = lazy(() => import('./pages/AgentDetail'));
const StartFromScratch = lazy(() => import('./pages/StartFromScratch'));
const RAG = lazy(() => import('./pages/integrations/RAG'));
const Tools = lazy(() => import('./pages/integrations/Tools'));
const Skills = lazy(() => import('./pages/integrations/Skills'));
const SubAgents = lazy(() => import('./pages/integrations/SubAgents'));
const Settings = lazy(() => import('./pages/Settings'));
const PSTN = lazy(() => import('./pages/telephony/PSTN'));
const SIP = lazy(() => import('./pages/telephony/SIP'));
const PhoneNumbers = lazy(() => import('./pages/telephony/PhoneNumbers'));
const EvalSuites = lazy(() => import('./pages/EvalSuites'));
const EvalSuiteDetail = lazy(() => import('./pages/EvalSuiteDetail'));
const EvalSuiteCompare = lazy(() => import('./pages/EvalSuiteCompare'));

const pageFallback = (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '40vh' }}>
    <p style={{ color: '#545b64', fontSize: '14px' }}>Loading page...</p>
  </div>
);

function AuthenticatedApp() {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <p style={{ color: '#545b64', fontSize: '14px' }}>Loading...</p>
      </div>
    );
  }

  // OAuth callback must be accessible before authentication
  if (window.location.pathname === '/callback') {
    return <OAuthCallback />;
  }

  if (!isAuthenticated) {
    return <Login />;
  }

  return (
    <FilterProvider>
    <WizardProvider>
      <BrowserRouter>
      <AutoSaveProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Overview />} />
            <Route path="/launch" element={<Launch />} />
            <Route path="/start" element={<StartFromScratch />} />
            <Route path="/home" element={<Home />} />
            {/* Path 1: Minimal Effort */}
            <Route path="/voice-1s" element={<Voice1S />} />
            {/* Path 2: Some Technical */}
            <Route path="/pipeline" element={<PipelineSelection />} />
            <Route path="/speech-to-speech" element={<SpeechToSpeech />} />
            <Route path="/cascaded" element={<CascadedSpeech />} />
            {/* Shared */}
            <Route path="/tools-selection" element={<Agents />} />
            <Route path="/prompt-builder" element={<PromptBuilder />} />
            <Route path="/summary" element={<Summary />} />
            <Route path="/poc" element={<POC />} />
            <Route path='/agents' element={<Demos />} />
            <Route path="/agents/:id" element={<AgentDetail />} />
            <Route path="/agents/:id/summary" element={<AgentDetail />} />
            <Route path="/agents/:id/workflow" element={<AgentDetail />} />
            <Route path="/agents/:id/conversations" element={<AgentDetail />} />
            <Route path="/agents/:id/users" element={<AgentDetail />} />
            <Route path="/agents/:id/cost" element={<AgentDetail />} />
            <Route path="/agents/:id/evaluation" element={<AgentDetail />} />
            <Route path="/agents/:id/evaluation/:jobId" element={<AgentDetail />} />
            {/* Integrations */}
            <Route path="/integrations/rag" element={<RAG />} />
            <Route path="/integrations/tools" element={<Tools />} />
            <Route path="/integrations/skills" element={<Skills />} />
            <Route path="/integrations/sub-agents" element={<SubAgents />} />
            {/* Telephony */}
            <Route path="/telephony/twilio" element={<PSTN />} />
            <Route path="/telephony/sip" element={<SIP />} />
            <Route path="/telephony/phone-numbers" element={<PhoneNumbers />} />
            <Route path="/settings" element={<Settings />} />
            {/* Eval Suites */}
            <Route path="/eval-suites" element={<EvalSuites />} />
            <Route path="/eval-suites/:id" element={<EvalSuiteDetail />} />
            <Route path="/eval-suites/:id/compare" element={<EvalSuiteCompare />} />
          </Route>
        </Routes>
      </AutoSaveProvider>
      </BrowserRouter>
    </WizardProvider>
    </FilterProvider>
  );
}

function App() {
  return (
    <AuthProvider>
      <Suspense fallback={pageFallback}>
        <AuthenticatedApp />
      </Suspense>
    </AuthProvider>
  );
}

export default App;
