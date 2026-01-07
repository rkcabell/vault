workers/py-ocr/
  src/
    main.py                  # queue poller: pull "ocr" jobs, push results
    env.py
    ocr_engine.py            # pytesseract adapter, preprocessing (binarize, deskew)
    pdf_to_image.py          # poppler/pdf2image glue
    client_s3.py             # download originals, upload OCR artifacts if needed
    client_api.py            # callback to API (signed endpoint) with OCR text payload
    telemetry.py             # OTEL spans, structured logs
  requirements.txt
  Dockerfile
  .env.example
