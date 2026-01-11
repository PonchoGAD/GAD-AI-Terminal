type HeaderProps = {
  locale: string;
  dict: {
    nav: {
      home: string;
      pricing: string;
      faq: string;
      contact: string;
    };
  };
};

export default function Header({ locale, dict }: HeaderProps) {
  return (
    <header className="border-b">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <span className="font-semibold">SaaS Demo</span>
        <nav className="space-x-4 text-sm text-gray-600">
          <a href={`/${locale}`}>{dict.nav.home}</a>
          <a href={`/${locale}/pricing`}>{dict.nav.pricing}</a>
          <a href={`/${locale}/faq`}>{dict.nav.faq}</a>
          <a href={`/${locale}/contact`}>{dict.nav.contact}</a>
        </nav>
      </div>
    </header>
  );
}
