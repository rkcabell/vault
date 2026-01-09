import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";

export default async function Default() {
  const cookieStore = await cookies();
  const isLoggedIn = Boolean(cookieStore.get("access_token")?.value);

  // if (isLoggedIn) redirect("/overview");

  return (
    <div className="landing-page">
      {/* Hero Section */}
      <section className="hero">
        <div className="hero__container">
          <h1 className="hero__title">Your Personal File Locker</h1>
          <p className="hero__subtitle">
            Transform your pile of documents, receipts, and photos into a searchable,
            organized system with automatic OCR text extraction and smart tagging.
          </p>
          <div className="hero__highlights">
            <div className="highlight">
              <span className="highlight__icon">🏠</span>
              <span className="highlight__text">Runs locally, free</span>
            </div>
            <div className="highlight">
              <span className="highlight__icon">🔍</span>
              <span className="highlight__text">Search everything</span>
            </div>
            <div className="highlight">
              <span className="highlight__icon">🏷️</span>
              <span className="highlight__text">Color-coded tags</span>
            </div>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="features">
        <div className="features__container">
          <h2 className="features__title">Everything in One Place</h2>
          <div className="features__grid">
            <div className="feature-card">
              <div className="feature-card__icon">📄</div>
              <h3 className="feature-card__title">Document Management</h3>
              <p className="feature-card__description">
                Upload PDFs, images, receipts, and scans. Automatic thumbnail generation
                and organization in one secure location.
              </p>
            </div>

            <div className="feature-card">
              <div className="feature-card__icon">🔤</div>
              <h3 className="feature-card__title">OCR Text Extraction</h3>
              <p className="feature-card__description">
                Advanced OCR technology extracts text from images and documents,
                making everything searchable and accessible.
              </p>
            </div>

            <div className="feature-card">
              <div className="feature-card__icon">🏷️</div>
              <h3 className="feature-card__title">Smart Organization</h3>
              <p className="feature-card__description">
                Color-coded tags and custom titles help you categorize and find
                documents quickly. Set reminders for time-sensitive items.
              </p>
            </div>

            <div className="feature-card">
              <div className="feature-card__icon">🔒</div>
              <h3 className="feature-card__title">Self-Hosted & Secure</h3>
              <p className="feature-card__description">
                Your data stays on your infrastructure. No cloud dependencies,
                no subscriptions, complete privacy control.
              </p>
            </div>

            <div className="feature-card">
              <div className="feature-card__icon">⚡</div>
              <h3 className="feature-card__title">Fast Search</h3>
              <p className="feature-card__description">
                Powerful search across file names, titles, tags, and extracted text.
                Find anything in seconds, not hours.
              </p>
            </div>

            <div className="feature-card">
              <div className="feature-card__icon">🖥️</div>
              <h3 className="feature-card__title">Web Interface</h3>
              <p className="feature-card__description">
                Clean, responsive web interface works on desktop and mobile.
                Upload, search, and manage from any device.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="cta">
        <div className="cta__container">
          <h2 className="cta__title">Ready to Organize Your Digital Life?</h2>
          <p className="cta__subtitle">
            Join the growing community of users who have transformed their document management.
          </p>
          <Link href="/overview" className="button button--cta">
            Get Started
          </Link>
        </div>
      </section>
    </div>
  );
}

