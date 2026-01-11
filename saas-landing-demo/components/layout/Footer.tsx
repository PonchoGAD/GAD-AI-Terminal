type FooterProps = {
  dict: any;
};

export default function Footer({ dict }: FooterProps) {
  return (
    <footer className="border-t py-6 text-center text-sm text-gray-500">
      © {new Date().getFullYear()} SaaS Landing Demo
    </footer>
  );
}
